/**
 * Task HTTP API tests (task 1.5 verify criterion) — real server on port 0
 * with a :memory: DB, exercising the full path: routing → auth → handler →
 * service → writer queue → event log.
 *
 *   (a) project + task CRUD round-trip;
 *   (b) transition endpoint: happy path, illegal path (409), systemOnly
 *       rejection (backlog→ready is recompute-driven), state in PATCH → 400;
 *   (c) dependency endpoints incl. cycle rejection over HTTP;
 *   (d) SSE stream delivers a live task.state_changed event.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer } from "../server/main.ts";

const TOKEN = "test-token-http";
const ORIGINAL_TOKEN = process.env.NIGHTSHIFT_API_TOKEN;

let server: ReturnType<typeof createServer>;

beforeEach(() => {
	process.env.NIGHTSHIFT_API_TOKEN = TOKEN;
	server = createServer({ port: 0, dbPath: ":memory:" });
});

afterEach(() => {
	server.stop(true);
	if (ORIGINAL_TOKEN === undefined) delete process.env.NIGHTSHIFT_API_TOKEN;
	else process.env.NIGHTSHIFT_API_TOKEN = ORIGINAL_TOKEN;
});

function call(method: string, path: string, body?: unknown): Promise<Response> {
	return fetch(new URL(path, server.url), {
		method,
		headers: {
			authorization: `Bearer ${TOKEN}`,
			...(body !== undefined ? { "content-type": "application/json" } : {}),
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
}

async function createProject(): Promise<number> {
	const res = await call("POST", "/projects", {
		name: "demo",
		repo_url: "https://example.test/demo.git",
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: number }).id;
}

async function createTask(projectId: number, overrides: Record<string, unknown> = {}): Promise<{ id: number; state: string }> {
	const res = await call("POST", "/tasks", { project_id: projectId, title: "a task", ...overrides });
	expect(res.status).toBe(201);
	return (await res.json()) as { id: number; state: string };
}

// ---------------------------------------------------------------------------
// CRUD round-trip

test("project + task CRUD round-trip", async () => {
	const projectId = await createProject();

	const listP = await call("GET", "/projects");
	expect(listP.status).toBe(200);
	expect(((await listP.json()) as Array<{ id: number }>).map((p) => p.id)).toEqual([projectId]);

	const task = await createTask(projectId, { description: "desc" });
	expect(task.state).toBe("draft");

	const got = await call("GET", `/tasks/${task.id}`);
	expect(got.status).toBe(200);
	expect((await got.json()) as Record<string, unknown>).toMatchObject({
		id: task.id,
		title: "a task",
		description: "desc",
		state: "draft",
		category: "functional",
		riskTier: "full",
	});

	const patched = await call("PATCH", `/tasks/${task.id}`, {
		title: "  renamed  ",
		priority: 5,
		category: "chore",
	});
	expect(patched.status).toBe(200);
	expect((await patched.json()) as Record<string, unknown>).toMatchObject({
		title: "renamed",
		priority: 5,
		category: "chore",
	});

	const backlogTask = await createTask(projectId, { state: "backlog", title: "second" });
	const filtered = await call("GET", `/tasks?project_id=${projectId}&state=backlog`);
	expect(filtered.status).toBe(200);
	expect(((await filtered.json()) as Array<{ id: number }>).map((t) => t.id)).toEqual([
		backlogTask.id,
	]);

	const deleted = await call("DELETE", `/tasks/${task.id}`);
	expect(deleted.status).toBe(200);
	expect((await call("GET", `/tasks/${task.id}`)).status).toBe(404);
});

test("validation errors surface as 400 envelopes", async () => {
	const projectId = await createProject();
	const res = await call("POST", "/tasks", { project_id: projectId, title: "   " });
	expect(res.status).toBe(400);
	expect(await res.json()).toEqual({
		error: { code: "invalid_request", message: expect.stringContaining("Title") },
	});
	// Unknown project → 404.
	const missing = await call("POST", "/tasks", { project_id: 999, title: "x" });
	expect(missing.status).toBe(404);
});

test("PATCH with state is rejected — transitions only", async () => {
	const projectId = await createProject();
	const task = await createTask(projectId);
	const res = await call("PATCH", `/tasks/${task.id}`, { state: "coding" });
	expect(res.status).toBe(400);
	expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
		"transition",
	);
});

test("DELETE on a mid-flight task → 409; cancelled task deletes fine", async () => {
	const projectId = await createProject();
	// Cancelled is a deletable parked state.
	const parked = await createTask(projectId, { state: "backlog" });
	await call("POST", `/tasks/${parked.id}/transition`, { to: "cancelled" });
	expect((await call("DELETE", `/tasks/${parked.id}`)).status).toBe(200);

	// `ready` is mid-flight. backlog→ready is system-driven, so trigger the
	// readiness recompute over HTTP: adding a dep edge between two siblings
	// recomputes the project, promoting the zero-dep backlog task `flight`.
	const flight = await createTask(projectId, { state: "backlog", title: "flight" });
	const s1 = await createTask(projectId, { title: "s1" });
	const s2 = await createTask(projectId, { title: "s2" });
	expect(
		(await call("POST", `/tasks/${s1.id}/dependencies`, { depends_on_task_id: s2.id })).status,
	).toBe(201);
	const promoted = await call("GET", `/tasks/${flight.id}`);
	expect(((await promoted.json()) as { state: string }).state).toBe("ready");

	const res = await call("DELETE", `/tasks/${flight.id}`);
	expect(res.status).toBe(409);
	expect(((await res.json()) as { error: { code: string } }).error.code).toBe("conflict");
});

// ---------------------------------------------------------------------------
// Transitions

test("transition endpoint: happy path and illegal path", async () => {
	const projectId = await createProject();
	const task = await createTask(projectId); // draft

	const ok = await call("POST", `/tasks/${task.id}/transition`, {
		to: "backlog",
		expected_from: "draft",
		actor: "human:test",
	});
	expect(ok.status).toBe(200);
	expect((await ok.json()) as Record<string, unknown>).toMatchObject({
		from: "draft",
		task: { id: task.id, state: "backlog" },
	});

	// backlog → coding is not a spec edge → 409 illegal_transition.
	const illegal = await call("POST", `/tasks/${task.id}/transition`, { to: "coding" });
	expect(illegal.status).toBe(409);
	expect(((await illegal.json()) as { error: { code: string } }).error.code).toBe(
		"illegal_transition",
	);

	// Regression: →done from an illegal from-state is 409 illegal_transition,
	// not a 400 "merge_sha required" (the guard must check legality first).
	const illegalDone = await call("POST", `/tasks/${task.id}/transition`, { to: "done" });
	expect(illegalDone.status).toBe(409);

	// backlog → ready is legal but system-driven → 400.
	const systemOnly = await call("POST", `/tasks/${task.id}/transition`, { to: "ready" });
	expect(systemOnly.status).toBe(400);

	// Unknown state name → 400; unknown task → 404.
	expect((await call("POST", `/tasks/${task.id}/transition`, { to: "nope" })).status).toBe(400);
	expect((await call("POST", "/tasks/999/transition", { to: "backlog" })).status).toBe(404);
});

// ---------------------------------------------------------------------------
// Dependencies over HTTP

test("dependency endpoints: add, cycle rejection, remove", async () => {
	const projectId = await createProject();
	const a = await createTask(projectId, { title: "a" });
	const b = await createTask(projectId, { title: "b" });

	const added = await call("POST", `/tasks/${a.id}/dependencies`, {
		depends_on_task_id: b.id,
	});
	expect(added.status).toBe(201);
	expect((await added.json()) as Record<string, unknown>).toMatchObject({
		taskId: a.id,
		dependsOnTaskId: b.id,
	});

	const cycle = await call("POST", `/tasks/${b.id}/dependencies`, { depends_on_task_id: a.id });
	expect(cycle.status).toBe(400);
	expect(((await cycle.json()) as { error: { message: string } }).error.message).toContain(
		"cycle",
	);

	const removed = await call("DELETE", `/tasks/${a.id}/dependencies/${b.id}`);
	expect(removed.status).toBe(200);
	expect((await call("DELETE", `/tasks/${a.id}/dependencies/${b.id}`)).status).toBe(404);
});

// ---------------------------------------------------------------------------
// SSE

test("GET /events/stream delivers a live task.state_changed event", async () => {
	const projectId = await createProject();
	const task = await createTask(projectId); // draft

	// Open the stream BEFORE the transition so the event arrives via live tail.
	const ac = new AbortController();
	const res = await fetch(new URL("/events/stream?after_seq=0", server.url), {
		headers: { authorization: `Bearer ${TOKEN}` },
		signal: ac.signal,
	});
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe("text/event-stream");
	const reader = res.body!.getReader();

	const trans = await call("POST", `/tasks/${task.id}/transition`, {
		to: "backlog",
		actor: "human:sse-test",
	});
	expect(trans.status).toBe(200);

	// Read frames until the transition's event shows up (bounded by attempts).
	const decoder = new TextDecoder();
	let buf = "";
	let found: Record<string, unknown> | undefined;
	for (let i = 0; i < 50 && !found; i++) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		for (const frame of buf.split("\n\n")) {
			if (!frame.startsWith("data: ")) continue;
			const event = JSON.parse(frame.slice("data: ".length)) as Record<string, unknown>;
			if (event.kind === "task.state_changed" && event.taskId === task.id) {
				found = event;
				break;
			}
		}
	}
	ac.abort();

	expect(found).toBeDefined();
	expect(found).toMatchObject({ kind: "task.state_changed", taskId: task.id, projectId });
	expect(JSON.parse((found as { payloadJson: string }).payloadJson)).toEqual({
		taskId: task.id,
		from: "draft",
		to: "backlog",
		actor: "human:sse-test",
		trigger: "promote",
	});
	expect(typeof (found as { seq: number }).seq).toBe("number");
});
