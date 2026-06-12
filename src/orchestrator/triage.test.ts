/**
 * WHY: Hermetic tests for triageFailedRun. All side-effects (DB, EventLog,
 * classifier, capacity, transcript reader) use in-memory fakes so these run on
 * macOS with no network, tmux, or filesystem.
 *
 * Coverage (≤5 cases per contract §6 test list):
 *   1. Transient error → requeued (retry, within maxRetries, coding→backlog→ready).
 *   2. Exhausted retries → needs_human (classifier never called).
 *   3. Classifier throws → needs_human (fail-closed).
 *   4. Auth failure → capacity.observe called with auth_limit; task goes to needs_human.
 *   5. Task already moved (not coding) → noop (stand-down).
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import type { TaskState } from "../db/columns.ts";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects, runs, tasks } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { triageFailedRun, defaultClassifier, type TriageDeps, type TriageClassifier } from "./triage.ts";
import { getTask } from "../tasks/tasks.ts";
import type { RunRow } from "../db/schema.ts";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

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
		.values({
			name: "triage-test",
			repoUrl: "https://github.com/o/r.git",
			createdAt: now,
			updatedAt: now,
		})
		.returning()
		.get().id;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed a task in `coding` state and a run in `failed` state.
 * `priorFailedCount` seeds that many additional failed runs before the main one
 * so the `attempts` counter reflects repeated failures.
 */
function seedFailedRun(
	opts: { taskState?: TaskState; priorFailedCount?: number; exitReason?: string } = {},
): { taskId: number; runId: number } {
	const taskState = opts.taskState ?? "coding";
	const now = new Date().toISOString();

	const taskId = handle.db
		.insert(tasks)
		.values({
			projectId,
			title: "triage test task",
			state: taskState,
			priority: 0,
			createdAt: now,
			updatedAt: now,
		})
		.returning()
		.get().id;

	// Prior failed runs (to simulate exhausted retries).
	const prior = opts.priorFailedCount ?? 0;
	for (let i = 0; i < prior; i++) {
		handle.db
			.insert(runs)
			.values({
				taskId,
				kind: "coder",
				provider: "claude-code",
				model: "claude-sonnet-4-5",
				authLane: "subscription",
				state: "failed",
				exitReason: "prior_failure",
			})
			.run();
	}

	const runId = handle.db
		.insert(runs)
		.values({
			taskId,
			kind: "coder",
			provider: "claude-code",
			model: "claude-sonnet-4-5",
			authLane: "subscription",
			state: "failed",
			exitReason: opts.exitReason ?? null,
		})
		.returning()
		.get().id;

	// Reflect production: the claim sets tasks.claimed_by = run.id. Triage's
	// superseded-run guard requires this to match.
	handle.db
		.update(tasks)
		.set({ claimedBy: runId })
		.where(eq(tasks.id, taskId))
		.run();

	return { taskId, runId };
}

/** Build a TriageDeps with injectable overrides. */
function makeDeps(overrides: {
	classifier?: TriageClassifier;
	transcriptTail?: string;
	capacityObservations?: Array<{ provider: string; kind: string; detail?: string }>;
	maxRetries?: number;
}): TriageDeps & { observations: Array<{ provider: string; kind: string; detail?: string }> } {
	const observations: Array<{ provider: string; kind: string; detail?: string }> = [];
	return {
		handle,
		log,
		classifier: overrides.classifier ?? defaultClassifier,
		readTranscriptTail: async (_run: RunRow) => overrides.transcriptTail ?? "",
		capacity: {
			async observe(signal) {
				observations.push(signal);
				if (overrides.capacityObservations) overrides.capacityObservations.push(signal);
			},
		},
		maxRetries: overrides.maxRetries ?? 2,
		observations,
	};
}

// ---------------------------------------------------------------------------
// Test 1: transient error → retry → requeued (within maxRetries)
// ---------------------------------------------------------------------------

describe("triageFailedRun", () => {
	test("transient error within maxRetries → requeued (failed→backlog→ready)", async () => {
		const { taskId, runId } = seedFailedRun({
			exitReason: "rate_limit exceeded",
		});

		// Deterministic classifier returns retry for rate-limit signal.
		const scripted: TriageClassifier = async () => ({
			action: "retry",
			reason: "transient_error: rate_limit",
		});

		const deps = makeDeps({ classifier: scripted, maxRetries: 2 });
		const outcome = await triageFailedRun(deps, runId);

		expect(outcome.applied).toBe("requeued");
		expect(outcome.decision.action).toBe("retry");
		expect(outcome.attempts).toBe(1); // 1 failed run so far

		// Task should be in ready (no deps → backlog→ready via recomputeReadiness).
		const task = getTask(handle, taskId);
		expect(task?.state).toBe("ready");

		// Capacity feedback was emitted.
		expect(deps.observations.length).toBeGreaterThanOrEqual(1);
		expect(deps.observations[0]?.kind).toBe("429");
	});

	// ---------------------------------------------------------------------------
	// Test 2: exhausted retries → needs_human, classifier never consulted
	// ---------------------------------------------------------------------------

	test("retries exhausted → needs_human, classifier never called", async () => {
		// maxRetries=2, priorFailedCount=2 means this run is attempt 3 (>2).
		const { taskId, runId } = seedFailedRun({ priorFailedCount: 2 });

		let classifierCalled = false;
		const scripted: TriageClassifier = async () => {
			classifierCalled = true;
			return { action: "retry", reason: "should_not_be_called" };
		};

		const deps = makeDeps({ classifier: scripted, maxRetries: 2 });
		const outcome = await triageFailedRun(deps, runId);

		expect(outcome.applied).toBe("needs_human");
		expect(outcome.decision.action).toBe("human");
		expect(outcome.decision.reason).toBe("retries_exhausted");
		expect(outcome.attempts).toBe(3); // 2 prior + 1 current

		// Classifier must NOT have been consulted.
		expect(classifierCalled).toBe(false);

		const task = getTask(handle, taskId);
		expect(task?.state).toBe("needs_human");
	});

	// ---------------------------------------------------------------------------
	// Test 3: classifier throws → needs_human (fail-closed)
	// ---------------------------------------------------------------------------

	test("classifier throws → needs_human (fail-closed)", async () => {
		const { taskId, runId } = seedFailedRun();

		const throwing: TriageClassifier = async () => {
			throw new Error("LLM request timed out");
		};

		const deps = makeDeps({ classifier: throwing, maxRetries: 2 });
		const outcome = await triageFailedRun(deps, runId);

		expect(outcome.applied).toBe("needs_human");
		expect(outcome.decision.action).toBe("human");
		expect(outcome.decision.reason).toBe("classifier_failed");

		const task = getTask(handle, taskId);
		expect(task?.state).toBe("needs_human");
	});

	// ---------------------------------------------------------------------------
	// Test 4: auth failure → capacity.observe called with auth_limit
	// ---------------------------------------------------------------------------

	test("auth failure → capacity.observe called with auth_limit; task → needs_human", async () => {
		const { taskId, runId } = seedFailedRun({
			exitReason: "authentication_error",
			transcriptTail: "invalid_api_key in response",
		} as { exitReason: string; transcriptTail?: string });
		// Note: exitReason is seeded on the run row; transcript is injected below.

		const scripted: TriageClassifier = async () => ({
			action: "human",
			reason: "auth_failure: authentication_error",
		});

		const deps = makeDeps({
			classifier: scripted,
			transcriptTail: "invalid_api_key in response",
			maxRetries: 2,
		});
		const outcome = await triageFailedRun(deps, runId);

		// Capacity signal must be auth_limit.
		expect(deps.observations.length).toBeGreaterThanOrEqual(1);
		const authObs = deps.observations.find((o) => o.kind === "auth_limit");
		expect(authObs).toBeDefined();
		expect(authObs?.provider).toBe("claude-code");

		// Task → needs_human (classifier returned human).
		expect(outcome.applied).toBe("needs_human");
		const task = getTask(handle, taskId);
		expect(task?.state).toBe("needs_human");
	});

	// ---------------------------------------------------------------------------
	// Test 5: task already moved (not in coding) → noop
	// ---------------------------------------------------------------------------

	test("task already moved out of coding → noop (stand-down)", async () => {
		// Seed task in needs_human (another actor already moved it).
		const { taskId, runId } = seedFailedRun({ taskState: "needs_human" });

		const scripted: TriageClassifier = async () => ({
			action: "retry",
			reason: "transient_error: rate_limit",
		});

		const deps = makeDeps({ classifier: scripted, maxRetries: 2 });
		const outcome = await triageFailedRun(deps, runId);

		expect(outcome.applied).toBe("noop");
		expect(outcome.decision.reason).toMatch(/task_not_coding/);

		// Task state must not have been changed.
		const task = getTask(handle, taskId);
		expect(task?.state).toBe("needs_human");
	});
});
