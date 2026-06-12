/**
 * Task state machine tests (task 1.5 verify criterion).
 *
 *   (a) FULL matrix: every from→to pair of the 11 task states is attempted;
 *       exactly the spec-allowed set (hard-coded here FROM the spec, not
 *       derived from the implementation table) succeeds, everything else is
 *       rejected as illegal — and every success emits exactly one
 *       task.state_changed event row with the right payload.
 *   (b) lost race: two concurrent claims on one ready task — exactly one
 *       wins, the loser gets {ok:false, reason:'lost_race'}, one event row.
 *   (c) one_active_run_per_task partial unique index holds.
 *   (d) invariant 3: done requires merge_sha; merge_sha only set at done.
 */

import { beforeEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import { TASK_STATES, type TaskState } from "../db/columns.ts";
import { runMigrations } from "../db/migrate.ts";
import { events, projects, runs, tasks } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { TASK_STATE_CHANGED, TASK_TRANSITIONS, transitionTask } from "./transitions.ts";
import { ValidationError } from "./tasks.ts";

/**
 * The expected legal set, transcribed by hand from SPEC-STATE-MACHINES §1 —
 * deliberately NOT derived from TASK_TRANSITIONS so the test catches drift
 * between the spec and the implementation table.
 */
const SPEC_ALLOWED: Record<TaskState, readonly TaskState[]> = {
	draft: ["backlog", "cancelled"],
	backlog: ["ready", "cancelled"],
	ready: ["coding", "cancelled"],
	coding: ["review", "failed", "needs_human", "cancelled"],
	review: ["coding", "approved", "needs_human", "cancelled"],
	approved: ["merging", "cancelled"],
	merging: ["done", "needs_human", "cancelled"],
	needs_human: ["coding", "merging", "cancelled"],
	failed: ["backlog", "cancelled"],
	done: [], // terminal
	cancelled: [], // terminal
};

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

/** Seed a task directly in an arbitrary state (bypasses the service on purpose). */
function seedTask(state: TaskState): number {
	const now = new Date().toISOString();
	return handle.db
		.insert(tasks)
		.values({
			projectId,
			title: `task in ${state}`,
			state,
			// Keep invariant 3 honest in fixtures: a done task has a merge_sha.
			mergeSha: state === "done" ? "seed-sha" : null,
			createdAt: now,
			updatedAt: now,
		})
		.returning()
		.get().id;
}

function stateChangeEvents(taskId: number) {
	return handle.db
		.select()
		.from(events)
		.where(and(eq(events.taskId, taskId), eq(events.kind, TASK_STATE_CHANGED)))
		.all();
}

test("implementation table covers exactly the spec-allowed pairs", () => {
	const implPairs = new Set(TASK_TRANSITIONS.map((t) => `${t.from}→${t.to}`));
	const specPairs = new Set(
		TASK_STATES.flatMap((from) => SPEC_ALLOWED[from].map((to) => `${from}→${to}`)),
	);
	expect([...implPairs].sort()).toEqual([...specPairs].sort());
});

test("full matrix: exactly the spec-allowed transitions succeed, each with one event row", async () => {
	const mismatches: string[] = [];
	for (const from of TASK_STATES) {
		for (const to of TASK_STATES) {
			const taskId = seedTask(from);
			const allowed = SPEC_ALLOWED[from].includes(to);
			const result = await transitionTask(handle, log, {
				taskId,
				to,
				actor: "test",
				// merging→done carries the merge sha; harmless for illegal pairs.
				extra: to === "done" ? { mergeSha: "abc123" } : undefined,
			});
			if (result.ok !== allowed) {
				mismatches.push(`${from}→${to}: expected ${allowed ? "legal" : "illegal"}, got ${JSON.stringify(result)}`);
				continue;
			}
			const row = handle.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
			const evs = stateChangeEvents(taskId);
			if (allowed) {
				if (row.state !== to) mismatches.push(`${from}→${to}: row state is ${row.state}`);
				if (evs.length !== 1) mismatches.push(`${from}→${to}: ${evs.length} event rows`);
				else {
					const payload = JSON.parse(evs[0]!.payloadJson) as Record<string, unknown>;
					if (payload.from !== from || payload.to !== to || payload.actor !== "test") {
						mismatches.push(`${from}→${to}: bad payload ${evs[0]!.payloadJson}`);
					}
				}
				// Invariant 3: merge_sha set ⟺ done.
				const expectSha = to === "done" || from === "done";
				if ((row.mergeSha !== null) !== expectSha) {
					mismatches.push(`${from}→${to}: mergeSha=${row.mergeSha}`);
				}
			} else {
				if (!result.ok && result.reason !== "illegal") {
					mismatches.push(`${from}→${to}: rejected as ${result.reason}, not illegal`);
				}
				if (row.state !== from) mismatches.push(`${from}→${to}: illegal pair mutated state`);
				if (evs.length !== 0) mismatches.push(`${from}→${to}: illegal pair emitted events`);
			}
		}
	}
	expect(mismatches).toEqual([]);
});

test("lost race: two concurrent claims — exactly one wins, loser sees lost_race", async () => {
	const taskId = seedTask("ready");
	const [a, b] = await Promise.all([
		transitionTask(handle, log, { taskId, to: "coding", expectedFrom: "ready", actor: "runner-1" }),
		transitionTask(handle, log, { taskId, to: "coding", expectedFrom: "ready", actor: "runner-2" }),
	]);
	const winners = [a, b].filter((r) => r.ok);
	const losers = [a, b].filter((r) => !r.ok);
	expect(winners).toHaveLength(1);
	expect(losers).toHaveLength(1);
	expect(losers[0]).toEqual({ ok: false, reason: "lost_race" });
	// Exactly one state change ⇒ exactly one event row (invariant 5).
	expect(stateChangeEvents(taskId)).toHaveLength(1);
	const row = handle.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
	expect(row.state).toBe("coding");
});

test("claim sets claimed_by; partial unique index one_active_run_per_task holds", async () => {
	const taskId = seedTask("ready");
	// A real run row so the claimed_by FK is satisfiable.
	const runId = handle.db
		.insert(runs)
		.values({ taskId, kind: "coder", provider: "p", model: "m", authLane: "local", state: "running" })
		.returning()
		.get().id;
	const result = await transitionTask(handle, log, {
		taskId,
		to: "coding",
		expectedFrom: "ready",
		actor: "runner-1",
		extra: { claimedBy: runId, baseSha: "base-sha", branch: `ns/${taskId}-claim` },
	});
	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.task.claimedBy).toBe(runId);
		expect(result.task.baseSha).toBe("base-sha");
		expect(result.task.branch).toBe(`ns/${taskId}-claim`);
	}
	// Second ACTIVE run for the same task violates the partial unique index…
	expect(() =>
		handle.db
			.insert(runs)
			.values({ taskId, kind: "coder", provider: "p", model: "m", authLane: "local", state: "queued" })
			.run(),
	).toThrow(/UNIQUE|constraint/i);
	// …but a terminal run coexists fine.
	handle.db
		.insert(runs)
		.values({ taskId, kind: "coder", provider: "p", model: "m", authLane: "local", state: "failed" })
		.run();
});

test("transition to done without merge_sha is a ValidationError (invariant 3)", async () => {
	const taskId = seedTask("merging");
	// merging→done is a LEGAL edge, so a missing merge_sha is a 400-class caller
	// bug. The guard now fires AFTER legality — inside the writer link on the
	// unpinned path — so it surfaces as a rejected promise, not a sync throw.
	await expect(
		transitionTask(handle, log, { taskId, to: "done", actor: "test" }),
	).rejects.toThrow(ValidationError);
	// Nothing moved, nothing emitted.
	const row = handle.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
	expect(row.state).toBe("merging");
	expect(stateChangeEvents(taskId)).toHaveLength(0);
});

test("illegal transition to done is illegal, not a missing-merge_sha error", async () => {
	// Regression: the merge_sha guard must run AFTER the legality check. draft→done
	// is not a spec edge, so it is an illegal_transition (HTTP 409) — never a
	// 400 "merge_sha required" that would mask the real reason.
	const taskId = seedTask("draft");
	const result = await transitionTask(handle, log, { taskId, to: "done", actor: "test" });
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe("illegal");
	// The illegal pair must not mutate state or emit events.
	const row = handle.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
	expect(row.state).toBe("draft");
	expect(stateChangeEvents(taskId)).toHaveLength(0);
});

test("merge_sha is only written by merging→done (invariant 3, other direction)", async () => {
	const taskId = seedTask("ready");
	// Even if a caller smuggles mergeSha into extra, a non-done transition ignores it.
	const result = await transitionTask(handle, log, {
		taskId,
		to: "coding",
		actor: "test",
		extra: { mergeSha: "smuggled" },
	});
	expect(result.ok).toBe(true);
	const row = handle.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
	expect(row.mergeSha).toBeNull();
});

test("failed→backlog demotion bumps priority past the project max", async () => {
	const now = new Date().toISOString();
	handle.db
		.insert(tasks)
		.values({ projectId, title: "high", state: "backlog", priority: 7, createdAt: now, updatedAt: now })
		.run();
	const taskId = handle.db
		.insert(tasks)
		.values({ projectId, title: "flaky", state: "failed", priority: 2, createdAt: now, updatedAt: now })
		.returning()
		.get().id;
	const result = await transitionTask(handle, log, { taskId, to: "backlog", actor: "policy" });
	expect(result.ok).toBe(true);
	if (result.ok) expect(result.task.priority).toBe(8);
});

test("missing task → not_found, never a throw", async () => {
	const result = await transitionTask(handle, log, { taskId: 999_999, to: "backlog", actor: "t" });
	expect(result).toEqual({ ok: false, reason: "not_found" });
});
