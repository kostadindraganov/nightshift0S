/**
 * Scheduler slot-filling tests (≤5, concurrency-critical paths only).
 *
 *   (a) fills ALL free slots in ONE pass — N slots, M ready tasks, capacity ok
 *       → exactly min(N,M) claimed, in priority order.
 *   (b) busy slots block: active coder runs consume slots; only the remainder
 *       is filled, capped at maxParallelSlots (never over-claim).
 *   (c) a capacity-denied provider is SKIPPED but the pass keeps filling with
 *       the next eligible task.
 *   (d) a startRun lost-race skip does NOT abort the pass — later tasks still fill.
 *   (e) concurrent kick()s coalesce into a single in-flight pass + at most one
 *       follow-up — startRun invocation count proves no over-claim.
 *
 * Real in-memory DB (so countActiveCoderRuns runs the real query); capacity,
 * resolveSpawn, and startRun are fakes — NO live spawn, NO network.
 */

import { beforeEach, expect, test } from "bun:test";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import type { RunState } from "../db/columns.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects, runs, tasks } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import {
	startScheduler,
	tickOnce,
	type CapacityPort,
	type SchedulerDeps,
	type SpawnPlan,
} from "./scheduler.ts";

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

/** Seed a ready task with a given priority (lower = scheduled first). */
function seedReadyTask(priority: number): number {
	const now = new Date().toISOString();
	return handle.db
		.insert(tasks)
		.values({ projectId, title: `t${priority}`, state: "ready", priority, createdAt: now, updatedAt: now })
		.returning()
		.get().id;
}

/** Seed a task in a given state (e.g. "review"/"approved") — counts as review-WIP. */
function seedTaskInState(state: "review" | "approved", priority: number): number {
	const now = new Date().toISOString();
	return handle.db
		.insert(tasks)
		.values({ projectId, title: `w${priority}`, state, priority, createdAt: now, updatedAt: now })
		.returning()
		.get().id;
}

/** Seed a coder run directly in a given (possibly active) state — occupies a slot. */
function seedCoderRun(state: RunState): void {
	handle.db
		.insert(runs)
		.values({ kind: "coder", provider: "claude-code", model: "m", authLane: "subscription", state })
		.run();
}

const okCapacity: CapacityPort = {
	canSpawn: async (_provider, lane) => ({ ok: true, lane }),
};

function plan(provider = "claude-code"): SpawnPlan {
	return { provider, model: "m", authLane: "subscription", prompt: "go", repoDir: "/r", homeRoot: "/h" };
}

/** Build deps with a recording fake startRun. `outcomes` keys by taskId. */
function makeDeps(over: Partial<SchedulerDeps> & { startedTaskIds?: number[] } = {}): SchedulerDeps {
	const started = over.startedTaskIds ?? [];
	return {
		handle,
		log,
		maxParallelSlots: 3,
		maxReviewWip: 999, // effectively unbounded so existing tests are unaffected
		capacity: okCapacity,
		resolveSpawn: async () => plan(),
		startRun: async (input) => {
			started.push(input.taskId);
			return { ok: true };
		},
		...over,
	};
}

// ---------------------------------------------------------------------------
// (a) fills ALL free slots in ONE pass, priority order
// ---------------------------------------------------------------------------

test("fills exactly min(slots, ready) in one pass, priority order", async () => {
	const t1 = seedReadyTask(1);
	const t2 = seedReadyTask(2);
	const t3 = seedReadyTask(3);
	const t4 = seedReadyTask(4); // 4 ready, 3 slots → only first 3 claimed

	const startedTaskIds: number[] = [];
	const deps = makeDeps({ maxParallelSlots: 3, startedTaskIds });

	const report = await tickOnce(deps);

	expect(report.activeAtStart).toBe(0);
	expect(report.started).toEqual([t1, t2, t3]);
	expect(startedTaskIds).toEqual([t1, t2, t3]);
	expect(report.skipped).toEqual([]);
	void t4;
});

// ---------------------------------------------------------------------------
// (b) busy slots block further claims (never over-claim past maxParallelSlots)
// ---------------------------------------------------------------------------

test("active coder runs occupy slots; only the remainder is filled", async () => {
	seedCoderRun("running"); // 1 active
	seedCoderRun("finishing"); // 1 active (non-terminal)
	seedCoderRun("failed"); // terminal → does NOT occupy a slot
	const t1 = seedReadyTask(1);
	const t2 = seedReadyTask(2);

	const startedTaskIds: number[] = [];
	const deps = makeDeps({ maxParallelSlots: 3, startedTaskIds });

	const report = await tickOnce(deps);

	// 3 slots − 2 active = 1 free → exactly one claim despite two ready tasks.
	expect(report.activeAtStart).toBe(2);
	expect(report.started).toEqual([t1]);
	expect(startedTaskIds).toEqual([t1]);
	void t2;

	// And with no free slots at all: maxParallelSlots=2 is fully occupied → no
	// further claim, startRun untouched (the over-claim floor case).
	const startedAtFull: number[] = [];
	const full = await tickOnce(makeDeps({ maxParallelSlots: 2, startedTaskIds: startedAtFull }));
	expect(full.started).toEqual([]);
	expect(startedAtFull).toEqual([]);
});

// ---------------------------------------------------------------------------
// (c) capacity-denied provider is skipped, fill continues with the next task
// ---------------------------------------------------------------------------

test("capacity refusal skips that task but the pass still fills the next", async () => {
	const t1 = seedReadyTask(1);
	const t2 = seedReadyTask(2);

	const startedTaskIds: number[] = [];
	const deps = makeDeps({
		maxParallelSlots: 3,
		startedTaskIds,
		// First task routes to a denied provider; second to an allowed one.
		resolveSpawn: async (task) =>
			task.id === t1 ? plan("at-cap-provider") : plan("good-provider"),
		capacity: {
			canSpawn: async (provider, lane) =>
				provider === "at-cap-provider"
					? { ok: false, reason: "at_cap" }
					: { ok: true, lane },
		},
	});

	const report = await tickOnce(deps);

	expect(report.skipped).toEqual([{ taskId: t1, reason: "at_cap" }]);
	expect(report.started).toEqual([t2]);
	expect(startedTaskIds).toEqual([t2]); // never spawned the denied task
});

// ---------------------------------------------------------------------------
// (d) startRun lost-race skip does not abort the pass
// ---------------------------------------------------------------------------

test("startRun lost-race skip does not abort the rest of the pass", async () => {
	const t1 = seedReadyTask(1);
	const t2 = seedReadyTask(2);

	const startedTaskIds: number[] = [];
	const deps = makeDeps({
		maxParallelSlots: 3,
		startedTaskIds,
		startRun: async (input) => {
			if (input.taskId === t1) return { ok: false, reason: "lost_race" };
			startedTaskIds.push(input.taskId);
			return { ok: true };
		},
	});

	const report = await tickOnce(deps);

	expect(report.skipped).toEqual([{ taskId: t1, reason: "lost_race" }]);
	expect(report.started).toEqual([t2]);
	expect(startedTaskIds).toEqual([t2]);
});

// ---------------------------------------------------------------------------
// (e) concurrent kick()s coalesce — single-flight prevents over-claim
// ---------------------------------------------------------------------------

test("concurrent kicks coalesce: each ready task is claimed exactly once", async () => {
	seedReadyTask(1);
	seedReadyTask(2);

	const startedTaskIds: number[] = [];
	let inStartRun = 0;
	let maxConcurrentStartRun = 0;

	const deps = makeDeps({
		maxParallelSlots: 5,
		startRun: async (input) => {
			inStartRun += 1;
			maxConcurrentStartRun = Math.max(maxConcurrentStartRun, inStartRun);
			await Promise.resolve(); // yield so a racing pass could interleave if not single-flight
			startedTaskIds.push(input.taskId);
			inStartRun -= 1;
			return { ok: true };
		},
	});

	const sched = startScheduler(deps, { intervalMs: 1_000_000, debounceMs: 0 });
	// Fire many wakes "simultaneously" — they must coalesce into one fill + at
	// most one follow-up, never N concurrent passes that double-claim.
	sched.kick();
	sched.kick();
	sched.kick();
	await new Promise((r) => setTimeout(r, 30));
	sched.stop();

	// Each ready task claimed exactly once (no duplicates) and never two passes
	// inside startRun at the same time.
	expect(startedTaskIds.slice().sort()).toEqual(startedTaskIds.slice().sort());
	expect(new Set(startedTaskIds).size).toBe(startedTaskIds.length);
	expect(startedTaskIds.length).toBe(2);
	expect(maxConcurrentStartRun).toBe(1);
});

// ---------------------------------------------------------------------------
// (f) review-WIP throttle: at/above the ceiling, claim NOTHING this pass
// ---------------------------------------------------------------------------

test("review-WIP at the ceiling throttles the pass — nothing is claimed", async () => {
	// Free slots and ready work exist, so a normal pass WOULD spawn...
	const t1 = seedReadyTask(1);
	const t2 = seedReadyTask(2);
	// ...but maxReviewWip tasks already sit in review/approved (PRs not yet merged).
	seedTaskInState("review", 10);
	seedTaskInState("review", 11);
	seedTaskInState("approved", 12); // 3 in review-WIP

	const startedTaskIds: number[] = [];
	const deps = makeDeps({ maxParallelSlots: 3, maxReviewWip: 3, startedTaskIds });

	const report = await tickOnce(deps);

	// reviewWip (3) >= maxReviewWip (3) → claim nothing despite free slots + ready tasks.
	expect(report.started).toEqual([]);
	expect(startedTaskIds).toEqual([]);
	void t1;
	void t2;

	// Companion: drop the ceiling to ABOVE the current WIP → it fills normally again.
	const startedBelow: number[] = [];
	const below = await tickOnce(makeDeps({ maxParallelSlots: 3, maxReviewWip: 4, startedTaskIds: startedBelow }));
	expect(below.started).toEqual([t1, t2]);
	expect(startedBelow).toEqual([t1, t2]);
});

// ---------------------------------------------------------------------------
// (g) containerConfig propagation: resolveSpawn → tickOnce → startRun (TASK 3)
//
// Proves the container isolation policy a routing closure puts on the SpawnPlan
// is carried, unchanged, into the startRun input — and that an absent policy
// stays absent (default behaviour unchanged).
// ---------------------------------------------------------------------------

test("containerConfig on the plan is threaded into the startRun input; absent stays absent", async () => {
	const t1 = seedReadyTask(1);
	const t2 = seedReadyTask(2);

	const enabledContainer = {
		enabled: true,
		runtime: "docker",
		image: "nightshift:latest",
		network: "none",
		memLimit: "4g",
		cpuLimit: "2",
	} as const;

	const received: Array<{ taskId: number; containerConfig: unknown }> = [];
	const deps = makeDeps({
		maxParallelSlots: 3,
		// t1 carries an enabled container policy; t2 carries none.
		resolveSpawn: async (task) =>
			task.id === t1
				? { ...plan(), containerConfig: enabledContainer }
				: plan(),
		startRun: async (input) => {
			received.push({ taskId: input.taskId, containerConfig: input.containerConfig });
			return { ok: true };
		},
	});

	const report = await tickOnce(deps);
	expect(report.started).toEqual([t1, t2]);

	const forT1 = received.find((r) => r.taskId === t1);
	const forT2 = received.find((r) => r.taskId === t2);
	// t1's plan carried the enabled policy through to startRun unchanged.
	expect(forT1?.containerConfig).toEqual(enabledContainer);
	// t2 carried no policy → undefined reaches startRun (default path unchanged).
	expect(forT2?.containerConfig).toBeUndefined();
});
