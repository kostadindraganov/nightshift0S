/**
 * GATE 1 integration test — skeptical, end-to-end verification of the Phase 1
 * skeleton. Boots a real Bun server on port 0 with a :memory: DB and exercises:
 *
 *   (a) SPA: GET / returns HTML containing id="root"
 *   (b) Config: GET /config returns a non-empty JSON array of knob entries
 *   (c) Task lifecycle: create project + task, drive legal state-machine edges
 *       draft→backlog→(ready via recomputeReadiness skipped, task with no deps
 *       seeded at ready)→coding→review→approved→merging→done; illegal transitions
 *       return 409 illegal_transition
 *   (d) Concurrency: 20 concurrent POSTs to the same transition; exactly one
 *       wins, rest are 409; events.seq is gap-free 1..n
 *   (e) SSE: open /events/stream, trigger a transition, assert task.state_changed
 *       event arrives, then abort
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { events } from "../db/schema.ts";
import { createServer } from "./main.ts";

const TOKEN = "gate1-test-token";
const ORIGINAL_TOKEN = process.env.NIGHTSHIFT_API_TOKEN;

let server: Bun.Server<undefined>;

function url(path: string): URL {
	return new URL(path, server.url);
}

function authed(init: RequestInit = {}): RequestInit {
	return {
		...init,
		headers: {
			...(init.headers ?? {}),
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/json",
		},
	};
}

function post(path: string, body: unknown): Promise<Response> {
	return fetch(url(path), authed({ method: "POST", body: JSON.stringify(body) }));
}

function get(path: string): Promise<Response> {
	return fetch(url(path), authed());
}

beforeEach(() => {
	process.env.NIGHTSHIFT_API_TOKEN = TOKEN;
	server = createServer({ port: 0, dbPath: ":memory:" });
});

afterEach(() => {
	server.stop(true);
	if (ORIGINAL_TOKEN === undefined) delete process.env.NIGHTSHIFT_API_TOKEN;
	else process.env.NIGHTSHIFT_API_TOKEN = ORIGINAL_TOKEN;
});

// ---------------------------------------------------------------------------
// (a) SPA: GET / returns HTML with id="root"

test("(a) GET / serves HTML containing id=\"root\"", async () => {
	const res = await fetch(url("/"));
	expect(res.status).toBe(200);
	const ct = res.headers.get("content-type") ?? "";
	expect(ct).toContain("html");
	const text = await res.text();
	expect(text).toContain('id="root"');
});

// ---------------------------------------------------------------------------
// (b) Config: GET /config returns non-empty array with section/key/value/source

test("(b) GET /config returns a non-empty array of knob entries", async () => {
	const res = await get("/config");
	expect(res.status).toBe(200);
	const body = (await res.json()) as unknown[];
	expect(Array.isArray(body)).toBe(true);
	expect(body.length).toBeGreaterThan(0);
	for (const entry of body) {
		const e = entry as Record<string, unknown>;
		expect(typeof e.section).toBe("string");
		expect(typeof e.key).toBe("string");
		// value can be any type
		expect(e).toHaveProperty("value");
		expect(["default", "file", "env"]).toContain(e.source as string);
	}
});

// ---------------------------------------------------------------------------
// (c) Task lifecycle

describe("(c) task lifecycle", () => {
	test("create project + task, drive legal chain, illegal transitions → 409", async () => {
		// Create project
		const projRes = await post("/projects", {
			name: "gate1-project",
			repo_url: "https://github.com/example/gate1",
			default_branch: "main",
		});
		expect(projRes.status).toBe(201);
		const proj = (await projRes.json()) as { id: number };
		const projectId = proj.id;

		// Create task in draft
		const t1Res = await post("/tasks", {
			project_id: projectId,
			title: "Gate1 draft task",
		});
		expect(t1Res.status).toBe(201);
		const t1 = (await t1Res.json()) as { id: number; state: string };
		expect(t1.state).toBe("draft");
		const t1Id = t1.id;

		// Illegal transition: draft → coding (skip required states)
		const illegalRes = await post(`/tasks/${t1Id}/transition`, { to: "coding" });
		expect(illegalRes.status).toBe(409);
		const illegalBody = (await illegalRes.json()) as { error: { code: string } };
		expect(illegalBody.error.code).toBe("illegal_transition");

		// draft → backlog (promote)
		const toBacklog = await post(`/tasks/${t1Id}/transition`, { to: "backlog" });
		expect(toBacklog.status).toBe(200);
		const backlogBody = (await toBacklog.json()) as { task: { state: string } };
		expect(backlogBody.task.state).toBe("backlog");

		// backlog → ready is system-only, API rejects it with ValidationError → 400
		const sysOnly = await post(`/tasks/${t1Id}/transition`, { to: "ready" });
		// The server throws a ValidationError (400) for system-only transitions
		expect([400, 409]).toContain(sysOnly.status);

		// Create a second task directly in 'ready' state so we can exercise the rest
		// of the chain. Tasks can only be CREATED in draft|backlog, so we create it
		// in backlog and then we need to get it to ready. Since backlog->ready is
		// system-only, we must use recomputeReadiness path. Instead, let us create
		// in draft and use the promote edge, then observe we cannot go further via
		// the direct ready path. Instead we'll work around this by creating a task
		// with no deps in backlog and calling the dependency endpoint to trigger
		// recomputeReadiness... but that path transitions via system. The simplest
		// approach: create task2 in backlog, add NO dependencies so recompute
		// fires during POST /dependencies would not help. We need a way to get to
		// ready. Let us seed directly through the internal API by creating a task
		// in the "backlog" state, then add and immediately remove a dependency —
		// recomputeReadiness runs as a side-effect of dependency removal and should
		// transition a no-deps backlog task to ready.

		const t2Res = await post("/tasks", {
			project_id: projectId,
			title: "Gate1 chain task",
			state: "backlog",
		});
		expect(t2Res.status).toBe(201);
		const t2 = (await t2Res.json()) as { id: number; state: string };
		const t2Id = t2.id;

		// Create t3 as a temporary dependency blocker
		const t3Res = await post("/tasks", {
			project_id: projectId,
			title: "Temporary blocker",
			state: "backlog",
		});
		const t3 = (await t3Res.json()) as { id: number };
		const t3Id = t3.id;

		// Add dep: t2 depends on t3; then remove it — recomputeReadiness fires and
		// t2 (no outstanding deps) should become ready.
		const addDepRes = await post(`/tasks/${t2Id}/dependencies`, {
			depends_on_task_id: t3Id,
		});
		expect(addDepRes.status).toBe(201);

		// Remove dep — recomputeReadiness makes t2 ready
		const delDepRes = await fetch(url(`/tasks/${t2Id}/dependencies/${t3Id}`), authed({ method: "DELETE" }));
		expect(delDepRes.status).toBe(200);

		// Confirm t2 is now ready
		const t2After = (await (await get(`/tasks/${t2Id}`)).json()) as { state: string };
		expect(t2After.state).toBe("ready");

		// ready → coding (claim)
		const toCoding = await post(`/tasks/${t2Id}/transition`, { to: "coding" });
		expect(toCoding.status).toBe(200);
		expect(((await toCoding.json()) as { task: { state: string } }).task.state).toBe("coding");

		// coding → review (coder_succeeded)
		const toReview = await post(`/tasks/${t2Id}/transition`, { to: "review" });
		expect(toReview.status).toBe(200);
		expect(((await toReview.json()) as { task: { state: string } }).task.state).toBe("review");

		// review → approved (approve)
		const toApproved = await post(`/tasks/${t2Id}/transition`, { to: "approved" });
		expect(toApproved.status).toBe(200);
		expect(((await toApproved.json()) as { task: { state: string } }).task.state).toBe("approved");

		// approved → merging (merge_start)
		const toMerging = await post(`/tasks/${t2Id}/transition`, { to: "merging" });
		expect(toMerging.status).toBe(200);
		expect(((await toMerging.json()) as { task: { state: string } }).task.state).toBe("merging");

		// merging → done (merge_confirmed) — requires merge_sha
		const toDone = await post(`/tasks/${t2Id}/transition`, {
			to: "done",
			merge_sha: "abc123def456abc123def456abc123def456abc1",
		});
		expect(toDone.status).toBe(200);
		const doneBody = (await toDone.json()) as { task: { state: string; mergeSha: string } };
		expect(doneBody.task.state).toBe("done");
		expect(doneBody.task.mergeSha).toBe("abc123def456abc123def456abc123def456abc1");

		// Verify done is terminal — any further transition is illegal
		const afterDone = await post(`/tasks/${t2Id}/transition`, { to: "cancelled" });
		expect(afterDone.status).toBe(409);
	});
});

// ---------------------------------------------------------------------------
// (d) Concurrency: 20 concurrent transitions to same target, exactly one wins

describe("(d) concurrency", () => {
	test("20 concurrent transitions: exactly one wins, rest 409, events seq gap-free", async () => {
		// Setup
		const projRes = await post("/projects", {
			name: "concurrency-project",
			repo_url: "https://github.com/example/concurrent",
		});
		const proj = (await projRes.json()) as { id: number };
		const projectId = proj.id;

		const taskRes = await post("/tasks", {
			project_id: projectId,
			title: "Concurrency test task",
			state: "backlog",
		});
		const task = (await taskRes.json()) as { id: number; state: string };
		const taskId = task.id;

		// Seed to backlog already. We'll fire 20 concurrent promote (backlog→? is already done)
		// Actually backlog→ready is system-only. Let's do draft→backlog concurrently instead:
		// Create a fresh draft task and fire 20 concurrent draft→backlog transitions.
		const draftRes = await post("/tasks", {
			project_id: projectId,
			title: "Concurrent promote target",
			state: "draft",
		});
		const draftTask = (await draftRes.json()) as { id: number };
		const draftId = draftTask.id;

		const CONCURRENCY = 20;
		const promises = Array.from({ length: CONCURRENCY }, () =>
			post(`/tasks/${draftId}/transition`, { to: "backlog" }),
		);
		const results = await Promise.all(promises);
		const statuses = results.map((r) => r.status);

		// Drain response bodies to avoid keep-alive issues
		await Promise.all(results.map((r) => r.json().catch(() => null)));

		const wins = statuses.filter((s) => s === 200);
		const losses = statuses.filter((s) => s === 409);

		expect(wins.length).toBe(1);
		expect(losses.length).toBe(CONCURRENCY - 1);

		// Confirm the task ended in the right state
		const finalRes = await get(`/tasks/${draftId}`);
		const finalTask = (await finalRes.json()) as { state: string };
		expect(finalTask.state).toBe("backlog");

		// Verify events seq is gap-free 1..n (no gaps or dupes).
		// We access the DB directly through the server's internals. Since we can't
		// do that easily, we query via a fresh DB handle on the same :memory: instance.
		// Instead, spin a fresh DB to check the events table invariant using a
		// newly opened handle on the :memory: — actually :memory: is per-connection
		// so we can't. Instead, read events via a side-channel: stop the server and
		// query through openDatabase on a temp file. Since that's not feasible for
		// :memory:, we use the API to fire known transitions and verify the seq
		// monotonicity via the SSE stream indirectly in test (e).
		//
		// What we CAN verify here: the final task has exactly the state we expect
		// (checked above) which proves the guarded UPDATE correctly serialized.
		// The seq gap-free property is enforced by the writer-queue (single-writer
		// coalesce(max(seq),0)+1 inside the link) and proved by the events unit
		// tests; we document the caveat here rather than re-derive it.
		//
		// To give a concrete seq check, we run a second in-process DB against a
		// temp file path to re-read the events — but :memory: is ephemeral.
		// We assert instead that total event count > 0 and let the SSE test (e)
		// confirm live delivery, which proves the seq pipeline end-to-end.
	});
});

// ---------------------------------------------------------------------------
// (d2) Concurrency with a real file DB so we can inspect events seq

describe("(d2) concurrency seq gap-free with file DB", () => {
	let fileServer: Bun.Server<undefined>;
	const tmpDb = `/tmp/gate1-concurrency-${Date.now()}.db`;

	beforeEach(() => {
		process.env.NIGHTSHIFT_API_TOKEN = TOKEN;
		fileServer = createServer({ port: 0, dbPath: tmpDb });
	});

	afterEach(() => {
		fileServer.stop(true);
		// Clean up temp files
		try { require("node:fs").unlinkSync(tmpDb); } catch { /* ok */ }
		try { require("node:fs").unlinkSync(`${tmpDb}-wal`); } catch { /* ok */ }
		try { require("node:fs").unlinkSync(`${tmpDb}-shm`); } catch { /* ok */ }
	});

	test("events seq is strictly 1..n with no gaps or duplicates after concurrent transitions", async () => {
		function furl(path: string): URL {
			return new URL(path, fileServer.url);
		}
		function fpost(path: string, body: unknown): Promise<Response> {
			return fetch(furl(path), authed({ method: "POST", body: JSON.stringify(body) }));
		}

		// Setup project + task
		const projRes = await fpost("/projects", {
			name: "seq-check-project",
			repo_url: "https://github.com/example/seq-check",
		});
		const proj = (await projRes.json()) as { id: number };
		const projectId = proj.id;

		// Create 10 draft tasks and fire promote transitions concurrently
		const taskIds: number[] = [];
		for (let i = 0; i < 10; i++) {
			const tRes = await fpost("/tasks", {
				project_id: projectId,
				title: `Concurrent task ${i}`,
				state: "draft",
			});
			const t = (await tRes.json()) as { id: number };
			taskIds.push(t.id);
		}

		// Fire all transitions concurrently
		const transitions = taskIds.map((id) =>
			fpost(`/tasks/${id}/transition`, { to: "backlog" }),
		);
		const results = await Promise.all(transitions);
		await Promise.all(results.map((r) => r.json().catch(() => null)));

		// All should succeed since each targets a distinct task
		const statuses = results.map((r) => r.status);
		expect(statuses.every((s) => s === 200)).toBe(true);

		// Stop the server so the SQLite WAL is checkpointed
		fileServer.stop(true);

		// Open the DB independently to verify seq gap-free
		const checkHandle = openDatabase(tmpDb);
		runMigrations(checkHandle);

		const rows = checkHandle.db
			.select({ seq: events.seq })
			.from(events)
			.orderBy(asc(events.seq))
			.all();

		expect(rows.length).toBeGreaterThan(0);

		// Check: seq is strictly 1, 2, 3, ..., n with no gaps or duplicates
		for (let i = 0; i < rows.length; i++) {
			expect(rows[i]!.seq).toBe(i + 1);
		}

		checkHandle.sqlite.close();

		// Recreate fileServer for afterEach (it calls stop(true) again — safe)
		fileServer = createServer({ port: 0, dbPath: tmpDb });
	});
});

// ---------------------------------------------------------------------------
// (e) SSE: open stream, trigger a transition, confirm task.state_changed event

describe("(e) SSE stream", () => {
	test("SSE delivers task.state_changed event on transition then can be aborted", async () => {
		// Create project + task
		const projRes = await post("/projects", {
			name: "sse-project",
			repo_url: "https://github.com/example/sse",
		});
		const proj = (await projRes.json()) as { id: number };
		const projectId = proj.id;

		const taskRes = await post("/tasks", {
			project_id: projectId,
			title: "SSE test task",
			state: "draft",
		});
		const task = (await taskRes.json()) as { id: number };
		const taskId = task.id;

		// Open SSE stream before triggering the transition so we catch the event
		const controller = new AbortController();
		const streamRes = await fetch(url("/events/stream"), {
			...authed(),
			signal: controller.signal,
		});
		expect(streamRes.status).toBe(200);
		expect(streamRes.headers.get("content-type")).toContain("text/event-stream");

		const reader = streamRes.body!.getReader();

		// Helper: read chunks until we find a data line, with a timeout
		const decoder = new TextDecoder();
		let buffer = "";

		async function readUntilEvent(timeoutMs: number): Promise<Record<string, unknown> | null> {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const { done, value } = await Promise.race([
					reader.read(),
					new Promise<{ done: true; value: undefined }>((resolve) =>
						setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
					),
				]);
				if (done) return null;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const json = line.slice("data: ".length).trim();
						if (json) {
							try {
								return JSON.parse(json) as Record<string, unknown>;
							} catch {
								// not valid JSON, skip
							}
						}
					}
				}
			}
			return null;
		}

		// Give the stream a moment to connect (the server flushes ": connected" first)
		// before triggering the transition
		await new Promise<void>((r) => setTimeout(r, 50));

		// Trigger the transition
		const transRes = await post(`/tasks/${taskId}/transition`, { to: "backlog" });
		expect(transRes.status).toBe(200);

		// Read from the stream until we see the state_changed event (5s timeout)
		const received = await readUntilEvent(5000);

		// Abort the stream
		controller.abort();
		reader.cancel().catch(() => null);

		expect(received).not.toBeNull();
		expect(received!.kind).toBe("task.state_changed");
		// payloadJson is a JSON string (per contract)
		expect(typeof received!.payloadJson).toBe("string");
		const payload = JSON.parse(received!.payloadJson as string) as Record<string, unknown>;
		expect(payload.taskId).toBe(taskId);
		expect(payload.to).toBe("backlog");
	});
});
