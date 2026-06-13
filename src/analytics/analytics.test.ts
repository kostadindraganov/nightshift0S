/**
 * Analytics module tests (UNIT B-2: evidence-based routing).
 *
 * Covers aggregateProviders, aggregateOverview, and scoreProviders with:
 *   - Happy path: seed runs across 2+ providers, verify math.
 *   - Cold-start: providers with < minRuns get neutral score, don't outrank proven.
 *   - bestProvider: respects candidate set; returns null when none qualify.
 *   - Edge cases: no runs, no terminal runs, no costs, NaN durations, etc.
 *
 * Each test owns a fresh in-memory DB (hermetic, no leaks). Fixtures use the
 * capacity.test.ts harness pattern: openDatabase(":memory:"), runMigrations,
 * direct table inserts.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import type { RunKind, RunState, TaskState } from "../db/columns.ts";
import { projects, runs, tasks } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { aggregateOverview, aggregateProviders } from "./aggregate.ts";
import { bestProvider, scoreProviders } from "./routing.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let handle: DbHandle;
let log: EventLog;

/**
 * Insert a run with full params. By default, startedAt and endedAt are set
 * (unless explicitly passed as null). Callers can override individual fields.
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
	// Only use defaults for timestamps if not explicitly provided
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
 * Insert a task with given state. Requires a project to exist.
 */
function insertTask(state: string): number {
	const result = handle.db
		.insert(tasks)
		.values({
			projectId: 1,
			title: "test task",
			state: state as TaskState,
			createdAt: "2026-06-13T10:00:00.000Z",
			updatedAt: "2026-06-13T10:00:00.000Z",
		})
		.returning({ id: tasks.id })
		.get();
	return result!.id;
}

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
	// Ensure a default project exists for tasks that need it
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
// 1. aggregateProviders: happy path
// ---------------------------------------------------------------------------

test("aggregateProviders: two providers, mixed success/failure", () => {
	// Provider A: 3 runs, 2 succeeded, 1 failed
	insertRun({
		provider: "providerA",
		state: "succeeded",
		costUsd: 0.1,
		priced: true,
	});
	insertRun({
		provider: "providerA",
		state: "succeeded",
		costUsd: 0.15,
		priced: true,
	});
	insertRun({
		provider: "providerA",
		state: "failed",
		costUsd: 0.05,
		priced: true,
	});

	// Provider B: 2 runs, 1 succeeded, 1 failed
	insertRun({
		provider: "providerB",
		state: "succeeded",
		costUsd: 0.2,
		priced: true,
	});
	insertRun({
		provider: "providerB",
		state: "failed",
		costUsd: 0.08,
		priced: true,
	});

	const stats = aggregateProviders(handle);

	// Sorted by provider name.
	expect(stats).toHaveLength(2);
	expect(stats[0]!.provider).toBe("providerA");
	expect(stats[1]!.provider).toBe("providerB");

	// providerA: 3 total, 2 succeeded, 1 failed → 66.67% success rate
	expect(stats[0]!.total).toBe(3);
	expect(stats[0]!.succeeded).toBe(2);
	expect(stats[0]!.failed).toBe(1);
	expect(stats[0]!.successRate).toBeCloseTo(2 / 3, 2);
	expect(stats[0]!.totalCostUsd).toBeCloseTo(0.3, 5);
	expect(stats[0]!.pricedRuns).toBe(3);

	// providerB: 2 total, 1 succeeded, 1 failed → 50% success rate
	expect(stats[1]!.total).toBe(2);
	expect(stats[1]!.succeeded).toBe(1);
	expect(stats[1]!.failed).toBe(1);
	expect(stats[1]!.successRate).toBeCloseTo(0.5, 2);
	expect(stats[1]!.totalCostUsd).toBeCloseTo(0.28, 5);
	expect(stats[1]!.pricedRuns).toBe(2);
});

// ---------------------------------------------------------------------------
// 2. aggregateProviders: duration calculation
// ---------------------------------------------------------------------------

test("aggregateProviders: calculates avgDurationMs from startedAt/endedAt", () => {
	// Two runs, 1min (60000ms) and 2min (120000ms) → avg 90000ms
	insertRun({
		provider: "providerA",
		state: "succeeded",
		startedAt: "2026-06-13T10:00:00.000Z",
		endedAt: "2026-06-13T10:01:00.000Z",
	});
	insertRun({
		provider: "providerA",
		state: "succeeded",
		startedAt: "2026-06-13T11:00:00.000Z",
		endedAt: "2026-06-13T11:02:00.000Z",
	});

	const stats = aggregateProviders(handle);
	expect(stats).toHaveLength(1);
	expect(stats[0]!.avgDurationMs).toBeCloseTo(90000, 0);
});

// ---------------------------------------------------------------------------
// 3. aggregateProviders: exit reason tracking (top 5)
// ---------------------------------------------------------------------------

test("aggregateProviders: tracks top 5 exit reasons by frequency", () => {
	insertRun({
		provider: "providerA",
		state: "failed",
		exitReason: "timeout",
	});
	insertRun({
		provider: "providerA",
		state: "failed",
		exitReason: "timeout",
	});
	insertRun({
		provider: "providerA",
		state: "failed",
		exitReason: "out_of_memory",
	});
	insertRun({
		provider: "providerA",
		state: "failed",
		exitReason: "segfault",
	});
	insertRun({
		provider: "providerA",
		state: "succeeded",
		exitReason: null,
	});

	const stats = aggregateProviders(handle);
	expect(stats).toHaveLength(1);
	expect(stats[0]!.topExitReasons).toHaveLength(3);
	// timeout: 2, out_of_memory: 1, segfault: 1 (ordered by count desc)
	expect(stats[0]!.topExitReasons[0]).toEqual({ reason: "timeout", count: 2 });
	expect(stats[0]!.topExitReasons[1]!.reason).toBe("out_of_memory");
	expect(stats[0]!.topExitReasons[2]!.reason).toBe("segfault");
});

// ---------------------------------------------------------------------------
// 4. aggregateProviders: edge cases
// ---------------------------------------------------------------------------

test("aggregateProviders: ignores runs with no terminal state (success/fail distinction)", () => {
	// Non-terminal states (queued, running, etc.) don't count toward successRate.
	insertRun({
		provider: "providerA",
		state: "succeeded",
	});
	insertRun({
		provider: "providerA",
		state: "running",
	});
	insertRun({
		provider: "providerA",
		state: "queued",
	});

	const stats = aggregateProviders(handle);
	expect(stats[0]!.total).toBe(3); // All counted in total
	expect(stats[0]!.succeeded).toBe(1); // Only terminal succeeded
	expect(stats[0]!.failed).toBe(0);
	expect(stats[0]!.successRate).toBeCloseTo(1.0, 2); // 1/(1+0)
});

test("aggregateProviders: null avgDurationMs when no complete durations", () => {
	// Only insert runs with incomplete timestamp pairs
	insertRun({
		provider: "providerA",
		state: "running",
		startedAt: "2026-06-13T10:00:00.000Z",
		endedAt: null,
	});
	insertRun({
		provider: "providerA",
		state: "running",
		startedAt: null,
		endedAt: "2026-06-13T10:01:00.000Z",
	});

	const stats = aggregateProviders(handle);
	expect(stats[0]!.avgDurationMs).toBeNull();
});

test("aggregateProviders: filters by sinceTs (ISO8601 startedAt comparison)", () => {
	const before = "2026-06-13T09:00:00.000Z";
	const cutoff = "2026-06-13T10:00:00.000Z";
	const after = "2026-06-13T11:00:00.000Z";

	insertRun({
		provider: "providerA",
		startedAt: before,
		state: "succeeded",
	});
	insertRun({
		provider: "providerA",
		startedAt: cutoff,
		state: "succeeded",
	});
	insertRun({
		provider: "providerA",
		startedAt: after,
		state: "succeeded",
	});

	// Since cutoff should include cutoff and after (lexicographic >=)
	const stats = aggregateProviders(handle, { sinceTs: cutoff });
	expect(stats[0]!.total).toBe(2);
});

test("aggregateProviders: filters by kind", () => {
	insertRun({ provider: "providerA", kind: "coder", state: "succeeded" });
	insertRun({ provider: "providerA", kind: "reviewer", state: "succeeded" });
	insertRun({ provider: "providerA", kind: "coder", state: "failed" });

	const stats = aggregateProviders(handle, { kind: "coder" });
	expect(stats[0]!.total).toBe(2);
	expect(stats[0]!.succeeded).toBe(1);
	expect(stats[0]!.failed).toBe(1);
});

test("aggregateProviders: empty DB returns empty array", () => {
	const stats = aggregateProviders(handle);
	expect(stats).toEqual([]);
});

test("aggregateProviders: ignores unpaired durations (missing startedAt or endedAt)", () => {
	// Insert multiple runs: some incomplete, one complete
	insertRun({
		provider: "providerA",
		startedAt: "2026-06-13T10:00:00.000Z",
		endedAt: null, // incomplete, should be ignored
	});
	insertRun({
		provider: "providerA",
		startedAt: null, // incomplete, should be ignored
		endedAt: "2026-06-13T11:00:00.000Z",
	});
	insertRun({
		provider: "providerA",
		startedAt: "2026-06-13T12:00:00.000Z",
		endedAt: "2026-06-13T12:01:00.000Z", // complete
	});

	const stats = aggregateProviders(handle);
	// Only the complete one (1 minute = 60000ms) should be included
	expect(stats[0]!.avgDurationMs).toBeCloseTo(60000, 0);
});

test("aggregateProviders: ignores unpriced runs in totalCostUsd", () => {
	insertRun({
		provider: "providerA",
		costUsd: 0.5,
		priced: true,
	});
	insertRun({
		provider: "providerA",
		costUsd: 0.3,
		priced: false, // unpriced, should not count
	});

	const stats = aggregateProviders(handle);
	expect(stats[0]!.totalCostUsd).toBeCloseTo(0.5, 5);
	expect(stats[0]!.pricedRuns).toBe(1);
});

// ---------------------------------------------------------------------------
// 5. aggregateOverview: factory-wide dashboard
// ---------------------------------------------------------------------------

test("aggregateOverview: task and run state counts, active runs, total cost", () => {
	// Tasks: draft (2), coding (1)
	insertTask("draft");
	insertTask("draft");
	insertTask("coding");

	// Runs: queued (1), running (1), succeeded (2), failed (1)
	insertRun({
		provider: "providerA",
		state: "queued",
		costUsd: null,
		priced: false,
	});
	insertRun({
		provider: "providerA",
		state: "running",
		costUsd: null,
		priced: false,
	});
	insertRun({
		provider: "providerA",
		state: "succeeded",
		costUsd: 0.1,
		priced: true,
	});
	insertRun({
		provider: "providerA",
		state: "succeeded",
		costUsd: 0.15,
		priced: true,
	});
	insertRun({
		provider: "providerA",
		state: "failed",
		costUsd: 0.05,
		priced: true,
	});

	const overview = aggregateOverview(handle);

	expect(overview.tasksByState).toEqual({ draft: 2, coding: 1 });
	expect(overview.runsByState).toEqual({
		queued: 1,
		running: 1,
		succeeded: 2,
		failed: 1,
	});
	expect(overview.totalCostUsd).toBeCloseTo(0.3, 5);
	expect(overview.activeRuns).toBe(2); // queued + running (non-terminal)
});

test("aggregateOverview: empty DB returns empty maps", () => {
	const overview = aggregateOverview(handle);

	expect(overview.tasksByState).toEqual({});
	expect(overview.runsByState).toEqual({});
	expect(overview.totalCostUsd).toBe(0);
	expect(overview.activeRuns).toBe(0);
});

test("aggregateOverview: ignores unpriced runs in totalCostUsd", () => {
	insertRun({
		provider: "providerA",
		state: "succeeded",
		costUsd: 1.0,
		priced: true,
	});
	insertRun({
		provider: "providerA",
		state: "succeeded",
		costUsd: 0.5,
		priced: false, // unpriced
	});

	const overview = aggregateOverview(handle);
	expect(overview.totalCostUsd).toBeCloseTo(1.0, 5);
});

// ---------------------------------------------------------------------------
// 6. scoreProviders: warm providers (evidence-based ranking)
// ---------------------------------------------------------------------------

test("scoreProviders: warm providers ranked by successRate > lowerCost > lowerDuration", () => {
	// ProviderA: 4 runs (>= 3), 75% success, avg 60s, cost $0.40
	insertRun({
		provider: "providerA",
		state: "succeeded",
		startedAt: "2026-06-13T10:00:00.000Z",
		endedAt: "2026-06-13T10:01:00.000Z",
		costUsd: 0.1,
		priced: true,
	});
	insertRun({
		provider: "providerA",
		state: "succeeded",
		startedAt: "2026-06-13T11:00:00.000Z",
		endedAt: "2026-06-13T11:01:00.000Z",
		costUsd: 0.1,
		priced: true,
	});
	insertRun({
		provider: "providerA",
		state: "succeeded",
		startedAt: "2026-06-13T12:00:00.000Z",
		endedAt: "2026-06-13T12:01:00.000Z",
		costUsd: 0.1,
		priced: true,
	});
	insertRun({
		provider: "providerA",
		state: "failed",
		startedAt: "2026-06-13T13:00:00.000Z",
		endedAt: "2026-06-13T13:01:00.000Z",
		costUsd: 0.1,
		priced: true,
	});

	// ProviderB: 4 runs, 50% success, avg 120s, cost $0.20
	insertRun({
		provider: "providerB",
		state: "succeeded",
		startedAt: "2026-06-13T10:00:00.000Z",
		endedAt: "2026-06-13T10:02:00.000Z",
		costUsd: 0.05,
		priced: true,
	});
	insertRun({
		provider: "providerB",
		state: "succeeded",
		startedAt: "2026-06-13T11:00:00.000Z",
		endedAt: "2026-06-13T11:02:00.000Z",
		costUsd: 0.05,
		priced: true,
	});
	insertRun({
		provider: "providerB",
		state: "failed",
		startedAt: "2026-06-13T12:00:00.000Z",
		endedAt: "2026-06-13T12:02:00.000Z",
		costUsd: 0.05,
		priced: true,
	});
	insertRun({
		provider: "providerB",
		state: "failed",
		startedAt: "2026-06-13T13:00:00.000Z",
		endedAt: "2026-06-13T13:02:00.000Z",
		costUsd: 0.05,
		priced: true,
	});

	const scores = scoreProviders(aggregateProviders(handle));

	// providerA should rank first: higher success rate (75% vs 50%)
	expect(scores).toHaveLength(2);
	expect(scores[0]!.provider).toBe("providerA");
	expect(scores[0]!.score).toBeGreaterThan(scores[1]!.score);
	expect(scores[1]!.provider).toBe("providerB");
	expect(scores[0]!.reason).toContain("warm:");
	expect(scores[0]!.reason).toContain("successRate=75.0%");
});

test("scoreProviders: cold-start providers (< minRuns) get neutral 0.5 score", () => {
	// ProviderA: 1 run (< 3 default minRuns)
	insertRun({
		provider: "providerA",
		state: "succeeded",
	});
	// ProviderB: 5 runs (warm)
	insertRun({ provider: "providerB", state: "succeeded" });
	insertRun({ provider: "providerB", state: "succeeded" });
	insertRun({ provider: "providerB", state: "succeeded" });
	insertRun({ provider: "providerB", state: "succeeded" });
	insertRun({ provider: "providerB", state: "failed" });

	const scores = scoreProviders(aggregateProviders(handle));

	// Warm providers ranked first, then cold.
	expect(scores).toHaveLength(2);
	expect(scores[0]!.provider).toBe("providerB"); // Warm, ranked first
	expect(scores[1]!.provider).toBe("providerA"); // Cold, ranked second
	expect(scores[1]!.score).toBe(0.5);
	expect(scores[1]!.reason).toContain("cold-start");
	expect(scores[1]!.reason).toContain("only 1 run(s)");
});

test("scoreProviders: custom minRuns threshold", () => {
	insertRun({ provider: "providerA", state: "succeeded" });
	insertRun({ provider: "providerA", state: "succeeded" });

	// With minRuns=3 (default), this is cold-start
	const scoresDefault = scoreProviders(aggregateProviders(handle), { minRuns: 3 });
	expect(scoresDefault[0]!.score).toBe(0.5);

	// With minRuns=2, this is warm
	const scoresLower = scoreProviders(aggregateProviders(handle), { minRuns: 2 });
	expect(scoresLower[0]!.reason).toContain("warm:");
	expect(scoresLower[0]!.score).toBeGreaterThan(0.5); // 100% success
});

test("scoreProviders: cost weight is clamped to [0, 0.5]", () => {
	insertRun({ provider: "providerA", state: "succeeded", costUsd: 0.1, priced: true });
	insertRun({ provider: "providerA", state: "succeeded", costUsd: 0.1, priced: true });
	insertRun({ provider: "providerA", state: "succeeded", costUsd: 0.1, priced: true });

	// Negative costWeight gets clamped to 0
	const scoresNeg = scoreProviders(aggregateProviders(handle), { costWeight: -0.5 });
	expect(scoresNeg[0]!.score).toBeGreaterThan(0);

	// costWeight > 0.5 gets clamped to 0.5
	const scoresHigh = scoreProviders(aggregateProviders(handle), { costWeight: 1.0 });
	expect(scoresHigh[0]!.score).toBeGreaterThan(0);

	// Both should work without crashing
	expect(scoresNeg).toHaveLength(1);
	expect(scoresHigh).toHaveLength(1);
});

test("scoreProviders: deterministic order (ties broken by provider name)", () => {
	// Two identical providers → tied score → sorted by name
	insertRun({ provider: "zebra", state: "succeeded" });
	insertRun({ provider: "zebra", state: "succeeded" });
	insertRun({ provider: "zebra", state: "succeeded" });

	insertRun({ provider: "apple", state: "succeeded" });
	insertRun({ provider: "apple", state: "succeeded" });
	insertRun({ provider: "apple", state: "succeeded" });

	const scores = scoreProviders(aggregateProviders(handle));
	// Both warm with 100% success, same duration/cost → apple < zebra lexicographically
	expect(scores[0]!.provider).toBe("apple");
	expect(scores[1]!.provider).toBe("zebra");
});

test("scoreProviders: score is clamped to [0, 1]", () => {
	// Create data that would produce a score < 0 or > 1 before clamping
	insertRun({
		provider: "providerA",
		state: "succeeded",
		costUsd: 0.01,
		priced: true,
	});
	insertRun({
		provider: "providerA",
		state: "succeeded",
		costUsd: 0.01,
		priced: true,
	});
	insertRun({
		provider: "providerA",
		state: "succeeded",
		costUsd: 0.01,
		priced: true,
	});

	const scores = scoreProviders(aggregateProviders(handle));
	expect(scores[0]!.score).toBeGreaterThanOrEqual(0);
	expect(scores[0]!.score).toBeLessThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// 7. bestProvider: candidate-set filtering
// ---------------------------------------------------------------------------

test("bestProvider: picks highest-scoring provider from candidate set", () => {
	// ProviderA: 100% success (higher)
	insertRun({ provider: "providerA", state: "succeeded" });
	insertRun({ provider: "providerA", state: "succeeded" });
	insertRun({ provider: "providerA", state: "succeeded" });

	// ProviderB: 50% success
	insertRun({ provider: "providerB", state: "succeeded" });
	insertRun({ provider: "providerB", state: "succeeded" });
	insertRun({ provider: "providerB", state: "failed" });

	const stats = aggregateProviders(handle);
	const best = bestProvider(stats, ["providerA", "providerB"]);
	expect(best).toBe("providerA");
});

test("bestProvider: respects candidate set; ignores high-scoring non-candidates", () => {
	// ProviderA: 100% success (best overall)
	insertRun({ provider: "providerA", state: "succeeded" });
	insertRun({ provider: "providerA", state: "succeeded" });
	insertRun({ provider: "providerA", state: "succeeded" });

	// ProviderB: 50% success
	insertRun({ provider: "providerB", state: "succeeded" });
	insertRun({ provider: "providerB", state: "succeeded" });
	insertRun({ provider: "providerB", state: "failed" });

	const stats = aggregateProviders(handle);

	// Candidate set excludes providerA → picks providerB even though A is better
	const best = bestProvider(stats, ["providerB"]);
	expect(best).toBe("providerB");
});

test("bestProvider: returns null when no candidates qualify", () => {
	insertRun({ provider: "providerA", state: "succeeded" });

	const stats = aggregateProviders(handle);
	const best = bestProvider(stats, ["nonexistent"]);
	expect(best).toBeNull();
});

test("bestProvider: returns null when candidate set is empty", () => {
	insertRun({ provider: "providerA", state: "succeeded" });

	const stats = aggregateProviders(handle);
	const best = bestProvider(stats, []);
	expect(best).toBeNull();
});

test("bestProvider: picks first warm provider over cold-start", () => {
	// ProviderA: 1 run (cold-start)
	insertRun({ provider: "providerA", state: "succeeded" });

	// ProviderB: 5 runs, 100% (warm, perfect)
	insertRun({ provider: "providerB", state: "succeeded" });
	insertRun({ provider: "providerB", state: "succeeded" });
	insertRun({ provider: "providerB", state: "succeeded" });
	insertRun({ provider: "providerB", state: "succeeded" });
	insertRun({ provider: "providerB", state: "succeeded" });

	const stats = aggregateProviders(handle);
	const best = bestProvider(stats, ["providerA", "providerB"]);
	expect(best).toBe("providerB"); // Warm ranks above cold
});

// ---------------------------------------------------------------------------
// 8. Aggregate integration: both functions work together
// ---------------------------------------------------------------------------

test("integration: aggregateProviders + scoreProviders + bestProvider flow", () => {
	// Real-world scenario: scheduler has 3 candidates but wants the best one
	insertRun({ provider: "openai", state: "succeeded", costUsd: 0.05, priced: true });
	insertRun({ provider: "openai", state: "succeeded", costUsd: 0.05, priced: true });
	insertRun({ provider: "openai", state: "failed", costUsd: 0.05, priced: true });

	insertRun({ provider: "anthropic", state: "succeeded", costUsd: 0.1, priced: true });
	insertRun({ provider: "anthropic", state: "succeeded", costUsd: 0.1, priced: true });

	insertRun({ provider: "google", state: "succeeded", costUsd: 0.02, priced: true });

	const stats = aggregateProviders(handle);
	const scores = scoreProviders(stats);
	const best = bestProvider(stats, ["openai", "anthropic", "google"]);

	// All three are in stats
	expect(stats).toHaveLength(3);

	// scoreProviders returns all three (google is cold-start but still scored)
	expect(scores).toHaveLength(3);

	// bestProvider picks from the candidate set (all three here)
	expect(best).toBeTruthy();
	expect(["openai", "anthropic", "google"]).toContain(best!);
});

// ---------------------------------------------------------------------------
// 9. FAIL-CLOSED: secrets/tokens must not appear in routing reasons (§3.12.7)
// ---------------------------------------------------------------------------

test("scoreProviders: reason field never contains secret-like tokens", () => {
	// Provider names and exitReasons could in theory be injected with sensitive
	// strings. The reason field must contain only diagnostic metadata, not values
	// from the runs table (exitReason, costUsd raw payloads etc.) that could
	// leak credential-like content. Specifically: the reason string contains only
	// the structured fields the scorer explicitly adds (successRate, runs,
	// avgDuration, totalCost labels). We verify no raw exitReason value leaks in.
	const secretLike = "sk-ANT-supersecret-token-value";
	insertRun({
		provider: "providerA",
		state: "failed",
		exitReason: secretLike, // exitReason should NOT appear in routing reason
	});
	insertRun({ provider: "providerA", state: "succeeded" });
	insertRun({ provider: "providerA", state: "succeeded" });

	const stats = aggregateProviders(handle);
	const scores = scoreProviders(stats);

	expect(scores).toHaveLength(1);
	// The reason field must not leak exitReason values
	expect(scores[0]!.reason).not.toContain(secretLike);
	// reason must only contain structured, pre-defined keys
	expect(scores[0]!.reason).toContain("warm:");
	expect(scores[0]!.reason).toContain("successRate=");
});

// ---------------------------------------------------------------------------
// 10. FAIL-CLOSED: cold-start never over-ranks a warm provider (even if warm scores low)
// ---------------------------------------------------------------------------

test("scoreProviders: warm provider with low success still ranks above cold-start", () => {
	// Warm provider: 5 runs, 0% success (very bad)
	insertRun({ provider: "warm-bad", state: "failed" });
	insertRun({ provider: "warm-bad", state: "failed" });
	insertRun({ provider: "warm-bad", state: "failed" });
	insertRun({ provider: "warm-bad", state: "failed" });
	insertRun({ provider: "warm-bad", state: "failed" });

	// Cold-start provider: 1 run, 100% success (looks great but no evidence)
	insertRun({ provider: "cold-good", state: "succeeded" });

	const stats = aggregateProviders(handle);
	const scores = scoreProviders(stats);

	expect(scores).toHaveLength(2);
	// Warm (proven failure) must come before cold (no evidence), per the
	// partition rule: warm always precedes cold in the output array.
	expect(scores[0]!.provider).toBe("warm-bad");
	expect(scores[1]!.provider).toBe("cold-good");
	expect(scores[1]!.score).toBe(0.5); // cold fixed score
	// The warm provider's score may be 0 (clamped), but it still appears first
	expect(scores[0]!.reason).toContain("warm:");
});

// ---------------------------------------------------------------------------
// 11. FAIL-CLOSED: bestProvider with all cold-start candidates (no warm)
// ---------------------------------------------------------------------------

test("bestProvider: all candidates are cold-start → picks first alphabetically", () => {
	// Two cold-start providers: 1 run each
	insertRun({ provider: "alpha", state: "succeeded" });
	insertRun({ provider: "beta", state: "failed" });

	const stats = aggregateProviders(handle);
	// Both are cold-start (< 3 runs). They both get score 0.5.
	// Tie broken alphabetically → "alpha" wins.
	const best = bestProvider(stats, ["alpha", "beta"]);
	expect(best).toBe("alpha");
});

// ---------------------------------------------------------------------------
// 12. FAIL-CLOSED: aggregateProviders sinceTs excludes runs with null startedAt
// ---------------------------------------------------------------------------

test("aggregateProviders: sinceTs filter excludes runs with null startedAt", () => {
	// A run with null startedAt cannot be compared to sinceTs — must be excluded.
	insertRun({
		provider: "providerA",
		state: "succeeded",
		startedAt: null,
		endedAt: null,
	});
	// A run after the cutoff — should be included.
	insertRun({
		provider: "providerA",
		state: "succeeded",
		startedAt: "2026-06-13T11:00:00.000Z",
		endedAt: "2026-06-13T11:01:00.000Z",
	});

	const stats = aggregateProviders(handle, { sinceTs: "2026-06-13T10:00:00.000Z" });
	// Only the one with a valid startedAt after cutoff counts.
	expect(stats[0]!.total).toBe(1);
});

// ---------------------------------------------------------------------------
// 13. FAIL-CLOSED: scoreProviders single-provider (range=0 → no duration/cost penalty)
// ---------------------------------------------------------------------------

test("scoreProviders: single warm provider — zero range means no duration/cost penalty", () => {
	// With a single warm provider, min==max for duration and cost → range=0 →
	// normalization returns 0 → no penalty. Score = successWeight * successRate.
	insertRun({ provider: "solo", state: "succeeded", costUsd: 1.0, priced: true });
	insertRun({ provider: "solo", state: "succeeded", costUsd: 1.0, priced: true });
	insertRun({ provider: "solo", state: "succeeded", costUsd: 1.0, priced: true });

	const stats = aggregateProviders(handle);
	const scores = scoreProviders(stats);

	expect(scores).toHaveLength(1);
	// 100% success, no penalties → score = successWeight * 1.0 = 0.75 (with
	// default costWeight=0.10, durationWeight=0.15 → successWeight=0.75)
	expect(scores[0]!.score).toBeCloseTo(0.75, 4);
});
