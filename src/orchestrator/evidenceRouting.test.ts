/**
 * Evidence-based routing closure tests (UNIT D-2).
 *
 * Covers chooseProviderByEvidence and makeEvidenceResolveSpawn with:
 *   - Happy path: rank the higher-success/lower-cost provider first.
 *   - Cold-start: no candidate with >= minRuns → returns first candidate (not null).
 *   - Wrapper: passes base plan through unchanged when no evidence; swaps provider
 *     when evidence favors another candidate.
 *
 * Each test owns a fresh in-memory DB (hermetic, no leaks). All side effects
 * faked: no network, no agent. Matrix: 3 focused cases (happy + cold-start +
 * wrapper behavior).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import type { RunKind, RunState, TaskState } from "../db/columns.ts";
import { projects, runs, tasks } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import type { TaskRow, RunRow } from "../db/schema.ts";
import type { SpawnPlan } from "../scheduler/scheduler.ts";
import {
	chooseProviderByEvidence,
	makeEvidenceResolveSpawn,
	type EvidenceResult,
} from "./evidenceRouting.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let handle: DbHandle;
let log: EventLog;

/**
 * Insert a run with given provider and state. By default, startedAt and endedAt
 * are set so duration is calculable. Callers can override individual fields.
 */
function insertRun(opts: {
	provider: string;
	kind?: string;
	model?: string;
	state?: string;
	startedAt?: string | null;
	endedAt?: string | null;
	costUsd?: number | null;
	priced?: boolean;
	exitReason?: string | null;
}): number {
	const startedAt = opts.startedAt !== undefined ? opts.startedAt : "2026-06-13T10:00:00.000Z";
	const endedAt = opts.endedAt !== undefined ? opts.endedAt : "2026-06-13T10:01:00.000Z";

	const result = handle.db
		.insert(runs)
		.values({
			kind: (opts.kind ?? "coder") as RunKind,
			provider: opts.provider,
			model: opts.model ?? "claude",
			authLane: "subscription",
			state: (opts.state ?? "succeeded") as RunState,
			startedAt,
			endedAt,
			costUsd: opts.costUsd ?? null,
			priced: opts.priced ?? false,
			exitReason: opts.exitReason ?? null,
		})
		.returning({ id: runs.id })
		.get();
	return result!.id;
}

/**
 * Insert a task with given state.
 */
function insertTask(state: string): TaskRow {
	const result = handle.db
		.insert(tasks)
		.values({
			projectId: 1,
			title: "test task",
			state: state as TaskState,
			createdAt: "2026-06-13T10:00:00.000Z",
			updatedAt: "2026-06-13T10:00:00.000Z",
		})
		.returning()
		.get();
	return result as TaskRow;
}

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
	// Insert default project for tasks
	handle.db
		.insert(projects)
		.values({
			name: "test",
			repoUrl: "https://github.com/test/test",
			defaultBranch: "main",
			createdAt: "2026-06-13T10:00:00.000Z",
			updatedAt: "2026-06-13T10:00:00.000Z",
		})
		.run();
});

afterEach(() => {
	handle.sqlite.close();
});

// ---------------------------------------------------------------------------
// 1. chooseProviderByEvidence: happy path (rank higher-success/lower-cost first)
// ---------------------------------------------------------------------------

test("chooseProviderByEvidence: ranks higher-success provider first", () => {
	// Provider A: 3 runs, 2 succeeded → 66.7% success
	insertRun({ provider: "providerA", state: "succeeded", costUsd: 0.1, priced: true });
	insertRun({ provider: "providerA", state: "succeeded", costUsd: 0.1, priced: true });
	insertRun({ provider: "providerA", state: "failed", costUsd: 0.1, priced: true });

	// Provider B: 3 runs, 1 succeeded → 33.3% success (lower)
	insertRun({ provider: "providerB", state: "succeeded", costUsd: 0.05, priced: true });
	insertRun({ provider: "providerB", state: "failed", costUsd: 0.05, priced: true });
	insertRun({ provider: "providerB", state: "failed", costUsd: 0.05, priced: true });

	// Choose between both candidates.
	const result = chooseProviderByEvidence(handle, ["providerA", "providerB"]);

	expect(result.provider).toBe("providerA");
	expect(result.reason).toContain("warm:");
	// Scores should be ranked best-first, providerA first.
	expect(result.scores).toHaveLength(2);
	expect(result.scores[0]!.provider).toBe("providerA");
	expect(result.scores[1]!.provider).toBe("providerB");
	expect(result.scores[0]!.score).toBeGreaterThan(result.scores[1]!.score);
});

// ---------------------------------------------------------------------------
// 2. chooseProviderByEvidence: cold-start (no minRuns → return first candidate)
// ---------------------------------------------------------------------------

test("chooseProviderByEvidence: cold-start returns first candidate when no evidence", () => {
	// No runs at all — both candidates are cold-start.
	const result = chooseProviderByEvidence(handle, ["providerA", "providerB"], {
		minRuns: 3,
	});

	// Cold-start fail-safe: return the first candidate (never null for non-empty input).
	expect(result.provider).toBe("providerA");
	expect(result.reason).toBe("cold_start");
	// Scores should still be present and both marked cold-start.
	expect(result.scores).toHaveLength(0); // No candidates with stats since no runs exist
});

test("chooseProviderByEvidence: cold-start with partial data returns first candidate", () => {
	// Provider A has only 1 run (below minRuns=3)
	// Provider B has 2 runs (still below minRuns=3)
	insertRun({ provider: "providerA", state: "succeeded" });
	insertRun({ provider: "providerB", state: "succeeded" });
	insertRun({ provider: "providerB", state: "succeeded" });

	const result = chooseProviderByEvidence(handle, ["providerA", "providerB"], {
		minRuns: 3,
	});

	// No warm evidence → return the first candidate with cold_start reason.
	expect(result.provider).toBe("providerA");
	expect(result.reason).toBe("cold_start");
	// Both should be in scores as cold-start (0.5).
	expect(result.scores).toHaveLength(2);
	expect(result.scores[0]!.score).toBe(0.5);
	expect(result.scores[1]!.score).toBe(0.5);
});

// ---------------------------------------------------------------------------
// 3. chooseProviderByEvidence: empty candidates
// ---------------------------------------------------------------------------

test("chooseProviderByEvidence: empty candidates → provider null", () => {
	insertRun({ provider: "providerA", state: "succeeded" });

	const result = chooseProviderByEvidence(handle, []);

	expect(result.provider).toBeNull();
	expect(result.scores).toEqual([]);
	expect(result.reason).toBe("no_candidates");
});

// ---------------------------------------------------------------------------
// 4. makeEvidenceResolveSpawn: passes base plan through unchanged (no evidence)
// ---------------------------------------------------------------------------

test("makeEvidenceResolveSpawn: passes base plan through when no evidence to swap", async () => {
	const task = insertTask("ready");
	const priorRuns: RunRow[] = [];

	// Base resolveSpawn that always returns a plan for providerA.
	const baseResolveSpawn = async (): Promise<SpawnPlan | null> => ({
		provider: "providerA",
		model: "claude",
		authLane: "subscription",
		prompt: "do something",
		repoDir: "/repo",
		homeRoot: "/home",
	});

	const wrapper = makeEvidenceResolveSpawn(baseResolveSpawn, { handle });
	const plan = await wrapper(task, priorRuns);

	// No runs in DB → cold-start → first candidate (providerA from candidates=[providerA])
	// Result: plan unchanged.
	expect(plan?.provider).toBe("providerA");
	expect(plan?.prompt).toBe("do something");
});

// ---------------------------------------------------------------------------
// 5. makeEvidenceResolveSpawn: swaps provider when evidence favors another
// ---------------------------------------------------------------------------

test("makeEvidenceResolveSpawn: swaps provider when evidence favors another candidate", async () => {
	const task = insertTask("ready");
	const priorRuns: RunRow[] = [];

	// Seed evidence: providerB is better than providerA.
	// Provider B: 4 runs, 3 succeeded → 75% success
	insertRun({ provider: "providerB", state: "succeeded", costUsd: 0.1, priced: true });
	insertRun({ provider: "providerB", state: "succeeded", costUsd: 0.1, priced: true });
	insertRun({ provider: "providerB", state: "succeeded", costUsd: 0.1, priced: true });
	insertRun({ provider: "providerB", state: "failed", costUsd: 0.1, priced: true });

	// Provider A: 3 runs, 1 succeeded → 33% success
	insertRun({ provider: "providerA", state: "succeeded", costUsd: 0.2, priced: true });
	insertRun({ provider: "providerA", state: "failed", costUsd: 0.2, priced: true });
	insertRun({ provider: "providerA", state: "failed", costUsd: 0.2, priced: true });

	// Base resolveSpawn returns a plan for providerA (suboptimal).
	const baseResolveSpawn = async (): Promise<SpawnPlan | null> => ({
		provider: "providerA",
		model: "claude",
		authLane: "subscription",
		prompt: "do something",
		repoDir: "/repo",
		homeRoot: "/home",
	});

	// Wrapper with candidatesFor allowing both A and B.
	const wrapper = makeEvidenceResolveSpawn(baseResolveSpawn, {
		handle,
		candidatesFor: () => ["providerA", "providerB"],
	});
	const plan = await wrapper(task, priorRuns);

	// Evidence should swap providerA → providerB (better score).
	expect(plan?.provider).toBe("providerB");
	expect(plan?.prompt).toBe("do something"); // Other fields unchanged.
});

// ---------------------------------------------------------------------------
// 6. makeEvidenceResolveSpawn: FAIL-CLOSED on any throw
// ---------------------------------------------------------------------------

test("makeEvidenceResolveSpawn: FAIL-CLOSED when evidence throws", async () => {
	const task = insertTask("ready");
	const priorRuns: RunRow[] = [];

	const basePlan: SpawnPlan = {
		provider: "providerA",
		model: "claude",
		authLane: "subscription",
		prompt: "do something",
		repoDir: "/repo",
		homeRoot: "/home",
	};

	const baseResolveSpawn = async (): Promise<SpawnPlan | null> => basePlan;

	// Wrapper with a broken candidatesFor (throws).
	const wrapper = makeEvidenceResolveSpawn(baseResolveSpawn, {
		handle,
		candidatesFor: () => {
			throw new Error("broken candidatesFor");
		},
	});

	const plan = await wrapper(task, priorRuns);

	// Should NOT throw; returns base plan unchanged (fail-closed).
	expect(plan).toEqual(basePlan);
});

// ---------------------------------------------------------------------------
// 7. makeEvidenceResolveSpawn: null base plan → null result
// ---------------------------------------------------------------------------

test("makeEvidenceResolveSpawn: null base plan → null result (no swap attempt)", async () => {
	const task = insertTask("ready");
	const priorRuns: RunRow[] = [];

	const baseResolveSpawn = async (): Promise<SpawnPlan | null> => null;

	const wrapper = makeEvidenceResolveSpawn(baseResolveSpawn, { handle });
	const plan = await wrapper(task, priorRuns);

	expect(plan).toBeNull();
});
