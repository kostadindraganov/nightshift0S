/**
 * Run CRUD + task-claim coupling tests.
 *
 *   (a) createRun inserts a run in state=queued.
 *   (b) A second active run for the same task throws RunConflictError (partial-unique).
 *   (c) claimTaskAndCreateRun moves a ready task to coding with claimedBy=run.id
 *       and creates the run.
 *   (d) Claiming an already-claimed (non-ready) task fails cleanly with no orphan run.
 *   (e) listRuns filtering by taskId and state.
 *   (f) getRun returns null for missing ids.
 *   (g) finishRun convenience wrapper transitions finishing→succeeded|failed.
 */

import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import { type TaskState } from "../db/columns.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects, runs, tasks } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import {
	claimTaskAndCreateRun,
	createRun,
	finishRun,
	getRun,
	listRuns,
	RunConflictError,
} from "./runs.ts";

let handle: DbHandle;
let log: EventLog;
let projectId: number;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
	const now = new Date().toISOString();
	projectId = handle.db
		.insert(projects)
		.values({ name: "p", repoUrl: "https://example.test/r.git", createdAt: now, updatedAt: now })
		.returning()
		.get().id;
});

/** Seed a task in an arbitrary state directly (bypasses service). */
function seedTask(state: TaskState): number {
	const now = new Date().toISOString();
	return handle.db
		.insert(tasks)
		.values({ projectId, title: `task in ${state}`, state, createdAt: now, updatedAt: now })
		.returning()
		.get().id;
}

// ---------------------------------------------------------------------------
// (a) createRun

test("createRun inserts a run in state=queued", async () => {
	const taskId = seedTask("coding");
	const run = await createRun(handle, {
		taskId,
		kind: "coder",
		provider: "claude-code",
		model: "claude-sonnet-4-5",
		authLane: "subscription",
	});
	expect(run.state).toBe("queued");
	expect(run.taskId).toBe(taskId);
	expect(run.kind).toBe("coder");
	expect(run.provider).toBe("claude-code");
});

// ---------------------------------------------------------------------------
// (b) Partial-unique index: second active run throws RunConflictError

test("second active run for the same task throws RunConflictError", async () => {
	const taskId = seedTask("coding");
	// First active run — succeeds.
	await createRun(handle, {
		taskId,
		kind: "coder",
		provider: "claude-code",
		model: "m",
		authLane: "local",
	});
	// Second active run — violates one_active_run_per_task.
	await expect(
		createRun(handle, {
			taskId,
			kind: "coder",
			provider: "claude-code",
			model: "m",
			authLane: "local",
		}),
	).rejects.toBeInstanceOf(RunConflictError);
});

test("terminal runs do not count against the unique index — two terminal runs are fine", async () => {
	const taskId = seedTask("coding");
	// Insert two terminal runs directly (they are not active).
	handle.db
		.insert(runs)
		.values({ taskId, kind: "coder", provider: "p", model: "m", authLane: "local", state: "succeeded" })
		.run();
	handle.db
		.insert(runs)
		.values({ taskId, kind: "coder", provider: "p", model: "m", authLane: "local", state: "failed" })
		.run();
	// And a fresh active run is still allowed.
	const run = await createRun(handle, { taskId, kind: "coder", provider: "p", model: "m", authLane: "local" });
	expect(run.state).toBe("queued");
});

// ---------------------------------------------------------------------------
// (c) claimTaskAndCreateRun — happy path

test("claimTaskAndCreateRun moves a ready task to coding with claimedBy=run.id", async () => {
	const taskId = seedTask("ready");
	const result = await claimTaskAndCreateRun(handle, log, {
		taskId,
		kind: "coder",
		provider: "claude-code",
		model: "claude-sonnet-4-5",
		authLane: "subscription",
	});
	expect(result.ok).toBe(true);
	if (!result.ok) return;

	// The run exists and is queued.
	expect(result.run.state).toBe("queued");
	expect(result.run.taskId).toBe(taskId);

	// The task is now in coding with claimedBy=run.id.
	const task = handle.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
	expect(task.state).toBe("coding");
	expect(task.claimedBy).toBe(result.run.id);
});

// ---------------------------------------------------------------------------
// (d) Race: claiming a non-ready task fails cleanly, no orphan run

test("claiming a non-ready task fails with no orphan run", async () => {
	// Task is in coding already — not ready.
	const taskId = seedTask("coding");

	// Insert a dummy active run so the task's state is "claimed" (partial-unique satisfied).
	// Actually the task is just not in ready state — the transition will fail.
	// But we also need to satisfy one_active_run_per_task for the seed run we'll create.
	// The dummy run we seed here IS the active run for that task, so claimTaskAndCreateRun
	// will first create a new run (which will hit the unique index if taskId=coding already
	// has an active run). Let's use a task that is coding with NO active run (direct insert).
	const result = await claimTaskAndCreateRun(handle, log, {
		taskId,
		kind: "coder",
		provider: "claude-code",
		model: "m",
		authLane: "local",
	});

	expect(result.ok).toBe(false);

	// No orphan run should remain active — any run created during the attempt
	// must have been killed.
	const activeRuns = handle.db
		.select()
		.from(runs)
		.where(eq(runs.taskId, taskId))
		.all()
		.filter(
			(r) => !["succeeded", "failed", "killed", "interrupted"].includes(r.state),
		);
	expect(activeRuns).toHaveLength(0);
});

test("concurrent claims on the same ready task — exactly one wins, no orphan from the loser", async () => {
	const taskId = seedTask("ready");

	// Two concurrent claims — only one task ready→coding edge can win.
	// One will succeed at createRun; the other will hit one_active_run_per_task
	// or the task transition lost race.
	const [a, b] = await Promise.allSettled([
		claimTaskAndCreateRun(handle, log, { taskId, kind: "coder", provider: "p", model: "m", authLane: "local" }),
		claimTaskAndCreateRun(handle, log, { taskId, kind: "coder", provider: "p", model: "m", authLane: "local" }),
	]);

	// Count active runs remaining.
	const allRuns = handle.db.select().from(runs).where(eq(runs.taskId, taskId)).all();
	const activeRuns = allRuns.filter(
		(r) => !["succeeded", "failed", "killed", "interrupted"].includes(r.state),
	);
	// At most one active run may survive.
	expect(activeRuns.length).toBeLessThanOrEqual(1);

	// The task must be in coding (exactly one claim succeeded).
	const task = handle.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
	expect(task.state).toBe("coding");

	// At least one of the two settled without an unhandled rejection being the
	// only outcome — either fulfilled:ok or fulfilled:!ok or rejected with
	// RunConflictError (the second concurrent createRun may throw).
	const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
	const successfulClaims = fulfilled
		.map((r) => (r as PromiseFulfilledResult<{ ok: boolean }>).value)
		.filter((v) => v.ok);
	expect(successfulClaims).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// (e) listRuns

test("listRuns returns all runs when no filter given", async () => {
	const taskId = seedTask("coding");
	await createRun(handle, { taskId, kind: "coder", provider: "p", model: "m", authLane: "local" });
	const all = listRuns(handle);
	expect(all.length).toBeGreaterThanOrEqual(1);
});

test("listRuns filters by taskId", async () => {
	const taskId1 = seedTask("coding");
	const taskId2 = seedTask("draft");
	await createRun(handle, { taskId: taskId1, kind: "coder", provider: "p", model: "m", authLane: "local" });
	// Insert a terminal run for task2 so both tasks have runs.
	handle.db
		.insert(runs)
		.values({ taskId: taskId2, kind: "coder", provider: "p", model: "m", authLane: "local", state: "succeeded" })
		.run();
	const task1Runs = listRuns(handle, { taskId: taskId1 });
	expect(task1Runs.every((r) => r.taskId === taskId1)).toBe(true);
});

test("listRuns filters by state", async () => {
	const taskId = seedTask("coding");
	await createRun(handle, { taskId, kind: "coder", provider: "p", model: "m", authLane: "local" });
	const queued = listRuns(handle, { state: "queued" });
	expect(queued.every((r) => r.state === "queued")).toBe(true);
	const running = listRuns(handle, { state: "running" });
	expect(running.every((r) => r.state === "running")).toBe(true);
});

// ---------------------------------------------------------------------------
// (f) getRun

test("getRun returns null for missing id", () => {
	expect(getRun(handle, 999_999)).toBeNull();
});

test("getRun returns the run when it exists", async () => {
	const taskId = seedTask("coding");
	const created = await createRun(handle, { taskId, kind: "coder", provider: "p", model: "m", authLane: "local" });
	const fetched = getRun(handle, created.id);
	expect(fetched).not.toBeNull();
	expect(fetched!.id).toBe(created.id);
});

// ---------------------------------------------------------------------------
// (g) finishRun

test("finishRun transitions finishing→succeeded and sets cost fields", async () => {
	const taskId = seedTask("coding");
	// Seed a run directly in finishing state.
	const runId = handle.db
		.insert(runs)
		.values({ taskId, kind: "coder", provider: "p", model: "m", authLane: "local", state: "finishing" })
		.returning()
		.get().id;

	const result = await finishRun(handle, log, {
		runId,
		outcome: "succeeded",
		exitReason: "normal_exit",
		cost: { tokensIn: 2000, tokensOut: 800, costUsd: 0.05, priced: true },
	});
	expect(result.ok).toBe(true);
	if (!result.ok) return;

	expect(result.run.state).toBe("succeeded");
	expect(result.run.exitReason).toBe("normal_exit");
	expect(result.run.tokensIn).toBe(2000);
	expect(result.run.tokensOut).toBe(800);
	expect(result.run.priced).toBe(true);
	expect(result.run.endedAt).not.toBeNull();
});

test("finishRun transitions finishing→failed", async () => {
	const taskId = seedTask("coding");
	const runId = handle.db
		.insert(runs)
		.values({ taskId, kind: "coder", provider: "p", model: "m", authLane: "local", state: "finishing" })
		.returning()
		.get().id;

	const result = await finishRun(handle, log, { runId, outcome: "failed", exitReason: "api_error" });
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.run.state).toBe("failed");
	expect(result.run.exitReason).toBe("api_error");
});
