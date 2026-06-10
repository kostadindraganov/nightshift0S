/**
 * Dependency + readiness tests (task 1.5 verify criterion).
 *
 *   (a) cycle rejection: direct (A↔B) and transitive (≥3 nodes);
 *   (b) self-dependency, duplicate, cross-project rejection;
 *   (c) recomputeReadiness promotes ONLY backlog tasks whose deps all carry
 *       a merge_sha (zero deps counts as satisfied), emits one
 *       task.state_changed event per promotion, and respects the project
 *       filter.
 */

import { beforeEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import type { TaskState } from "../db/columns.ts";
import { runMigrations } from "../db/migrate.ts";
import { events, projects, tasks } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import {
	addDependency,
	listDependencyIds,
	recomputeReadiness,
	removeDependency,
} from "./dependencies.ts";
import { TASK_STATE_CHANGED } from "./transitions.ts";
import { ValidationError } from "./tasks.ts";

let handle: DbHandle;
let log: EventLog;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
});

function seedProject(name: string): number {
	const now = new Date().toISOString();
	return handle.db
		.insert(projects)
		.values({ name, repoUrl: "https://example.test/r.git", createdAt: now, updatedAt: now })
		.returning()
		.get().id;
}

function seedTask(projectId: number, state: TaskState, mergeSha: string | null = null): number {
	const now = new Date().toISOString();
	return handle.db
		.insert(tasks)
		.values({ projectId, title: `t-${state}`, state, mergeSha, createdAt: now, updatedAt: now })
		.returning()
		.get().id;
}

// ---------------------------------------------------------------------------
// addDependency / removeDependency

test("adds and removes an edge", async () => {
	const p = seedProject("p");
	const a = seedTask(p, "draft");
	const b = seedTask(p, "draft");
	const edge = await addDependency(handle, a, b);
	expect(edge).toMatchObject({ taskId: a, dependsOnTaskId: b });
	expect(listDependencyIds(handle, a)).toEqual([b]);
	expect(await removeDependency(handle, a, b)).toBe(true);
	expect(listDependencyIds(handle, a)).toEqual([]);
	expect(await removeDependency(handle, a, b)).toBe(false);
});

test("rejects self-dependency", () => {
	const p = seedProject("p");
	const a = seedTask(p, "draft");
	expect(() => addDependency(handle, a, a)).toThrow(/cannot depend on itself/);
});

test("rejects missing tasks with 404", () => {
	const p = seedProject("p");
	const a = seedTask(p, "draft");
	try {
		addDependency(handle, a, 999_999);
		throw new Error("expected throw");
	} catch (err) {
		expect(err).toBeInstanceOf(ValidationError);
		expect((err as ValidationError).status).toBe(404);
	}
});

test("rejects duplicates with 409", async () => {
	const p = seedProject("p");
	const a = seedTask(p, "draft");
	const b = seedTask(p, "draft");
	await addDependency(handle, a, b);
	try {
		await addDependency(handle, a, b);
		throw new Error("expected throw");
	} catch (err) {
		expect(err).toBeInstanceOf(ValidationError);
		expect((err as ValidationError).status).toBe(409);
	}
});

test("rejects cross-project dependencies", () => {
	const a = seedTask(seedProject("p1"), "draft");
	const b = seedTask(seedProject("p2"), "draft");
	expect(() => addDependency(handle, a, b)).toThrow(/same project/);
});

test("rejects a direct cycle (A→B then B→A)", async () => {
	const p = seedProject("p");
	const a = seedTask(p, "draft");
	const b = seedTask(p, "draft");
	await addDependency(handle, a, b);
	expect(() => addDependency(handle, b, a)).toThrow(/cycle/);
});

test("rejects a transitive cycle across ≥3 nodes (A→B→C, then C→A)", async () => {
	const p = seedProject("p");
	const a = seedTask(p, "draft");
	const b = seedTask(p, "draft");
	const c = seedTask(p, "draft");
	await addDependency(handle, a, b);
	await addDependency(handle, b, c);
	expect(() => addDependency(handle, c, a)).toThrow(/cycle/);
	// The legal diamond is still fine: A→C.
	await addDependency(handle, a, c);
});

// ---------------------------------------------------------------------------
// recomputeReadiness

test("promotes only backlog tasks whose deps ALL have merge_sha", async () => {
	const p = seedProject("p");
	const mergedDep1 = seedTask(p, "done", "sha-1");
	const mergedDep2 = seedTask(p, "done", "sha-2");
	const unmergedDep = seedTask(p, "coding");

	const fullyMerged = seedTask(p, "backlog");
	await addDependency(handle, fullyMerged, mergedDep1);
	await addDependency(handle, fullyMerged, mergedDep2);

	const partiallyMerged = seedTask(p, "backlog");
	await addDependency(handle, partiallyMerged, mergedDep1);
	await addDependency(handle, partiallyMerged, unmergedDep);

	const zeroDeps = seedTask(p, "backlog");
	const draftTask = seedTask(p, "draft"); // not backlog → never touched

	const promoted = await recomputeReadiness(handle, log, p);
	expect(promoted.map((t) => t.id).sort()).toEqual([fullyMerged, zeroDeps].sort());

	const stateOf = (id: number) =>
		handle.db.select().from(tasks).where(eq(tasks.id, id)).get()!.state;
	expect(stateOf(fullyMerged)).toBe("ready");
	expect(stateOf(zeroDeps)).toBe("ready");
	expect(stateOf(partiallyMerged)).toBe("backlog");
	expect(stateOf(draftTask)).toBe("draft");

	// One task.state_changed event per promotion, none for the others.
	const changeEvents = (id: number) =>
		handle.db
			.select()
			.from(events)
			.where(and(eq(events.taskId, id), eq(events.kind, TASK_STATE_CHANGED)))
			.all();
	expect(changeEvents(fullyMerged)).toHaveLength(1);
	expect(JSON.parse(changeEvents(fullyMerged)[0]!.payloadJson)).toMatchObject({
		from: "backlog",
		to: "ready",
		actor: "system",
	});
	expect(changeEvents(zeroDeps)).toHaveLength(1);
	expect(changeEvents(partiallyMerged)).toHaveLength(0);

	// Idempotent: a second recompute promotes nothing new.
	expect(await recomputeReadiness(handle, log, p)).toEqual([]);
});

test("removing the blocking dependency lets the task promote", async () => {
	const p = seedProject("p");
	const merged = seedTask(p, "done", "sha");
	const blocker = seedTask(p, "coding");
	const blocked = seedTask(p, "backlog");
	await addDependency(handle, blocked, merged);
	await addDependency(handle, blocked, blocker);

	expect((await recomputeReadiness(handle, log, p)).map((t) => t.id)).toEqual([]);
	await removeDependency(handle, blocked, blocker);
	expect((await recomputeReadiness(handle, log, p)).map((t) => t.id)).toEqual([blocked]);
});

test("project filter: other projects' backlog tasks are left alone", async () => {
	const p1 = seedProject("p1");
	const p2 = seedProject("p2");
	const inP1 = seedTask(p1, "backlog");
	const inP2 = seedTask(p2, "backlog");

	const promoted = await recomputeReadiness(handle, log, p1);
	expect(promoted.map((t) => t.id)).toEqual([inP1]);
	expect(handle.db.select().from(tasks).where(eq(tasks.id, inP2)).get()!.state).toBe("backlog");

	// Unscoped recompute sweeps the rest.
	const all = await recomputeReadiness(handle, log);
	expect(all.map((t) => t.id)).toEqual([inP2]);
});
