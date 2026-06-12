/**
 * WHY: Failure auto-triage for terminal-FAILED coder runs (PHASE5A §6, plan
 * item 5.9). Reads exit_reason + transcript tail, feeds a classifier (injected
 * — haiku-class LLM in production, deterministic keyword matcher by default),
 * and applies the decision via existing task-state edges. FAIL-CLOSED: an
 * unknown decision, a classifier throw, or exhausted retries all escalate to
 * needs_human — never an infinite retry loop, never silent over-spawn.
 *
 * The retry/reassign distinction is recorded in the run.triaged audit event so
 * the scheduler's resolveSpawn closure can avoid the last failed provider on
 * the next claim (§3.12.18: failback ≠ routing; cross-provider moves happen
 * only at task re-start, never mid-task). Triage itself never spawns.
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { RunRow } from "../db/schema.ts";
import { getTask } from "../tasks/tasks.ts";
import { getRun, listRuns } from "../runs/runs.ts";
import { transitionTask } from "../tasks/transitions.ts";
import { recomputeReadiness } from "../tasks/dependencies.ts";
import { signalFromExitReason } from "../providers/capacity.ts";

// ---------------------------------------------------------------------------
// Public types (pinned exports — §6.1)
// ---------------------------------------------------------------------------

export type TriageAction = "retry" | "reassign" | "human";

export interface TriageInput {
	runId: number;
	taskId: number;
	provider: string;
	exitReason: string | null;
	transcriptTail: string;
	attempt: number;      // failed coder runs so far for this task (incl. this one)
	maxRetries: number;
}

export interface TriageDecision {
	action: TriageAction;
	reason: string;
}

export type TriageClassifier = (input: TriageInput) => Promise<TriageDecision>;

// ---------------------------------------------------------------------------
// Default deterministic classifier
// ---------------------------------------------------------------------------

/**
 * Keyword patterns that indicate transient provider errors → retry (same
 * provider). Mirrors watchdog.ts API_ERROR_PATTERNS + rate-limit variants.
 */
const RETRY_PATTERNS = [
	"overloaded_error",
	"rate_limit",
	"rate limit",
	"429",
	"api error",
	"500 internal server",
	"503 service unavailable",
	"connection reset",
	"econnrefused",
] as const;

/**
 * Keyword patterns that indicate a dead auth lane → reassign (§3.12.18:
 * within-vendor failback first, then cross-provider at re-start via routing).
 */
const REASSIGN_PATTERNS = [
	"authentication_error",
	"invalid_api_key",
	"auth_limit",
	"unauthorized",
	"permission denied",
] as const;

/**
 * Default deterministic classifier (no network — keyword tier). Mirrors the
 * watchdog API_ERROR_PATTERNS precedent. rate-limit/overloaded/5xx → retry;
 * auth/invalid_key → reassign; unrecognized → human.
 */
export const defaultClassifier: TriageClassifier = async (
	input: TriageInput,
): Promise<TriageDecision> => {
	const combined = [input.exitReason ?? "", input.transcriptTail].join(" ").toLowerCase();

	for (const pattern of REASSIGN_PATTERNS) {
		if (combined.includes(pattern)) {
			return { action: "reassign", reason: `auth_failure: ${pattern}` };
		}
	}

	for (const pattern of RETRY_PATTERNS) {
		if (combined.includes(pattern)) {
			return { action: "retry", reason: `transient_error: ${pattern}` };
		}
	}

	return { action: "human", reason: "unrecognized_exit_reason" };
};

// ---------------------------------------------------------------------------
// TriageDeps + TriageOutcome
// ---------------------------------------------------------------------------

export interface TriageDeps {
	handle: DbHandle;
	log: EventLog;
	classifier: TriageClassifier;
	/** Same contract as WatchdogDeps.readTranscriptTail — never throws, "" on error. */
	readTranscriptTail(run: RunRow): Promise<string>;
	/** Local structural port to capacity.observe (§3.1) — do NOT import capacity.ts. */
	capacity: {
		observe(signal: {
			provider: string;
			kind: "429" | "auth_limit" | "error";
			detail?: string;
		}): Promise<void>;
	};
	maxRetries: number;  // config triage.maxRetries
}

export interface TriageOutcome {
	applied: "requeued" | "needs_human" | "noop";
	decision: TriageDecision;
	attempts: number;
}

// ---------------------------------------------------------------------------
// Capacity signal extraction
// ---------------------------------------------------------------------------

/**
 * Map exitReason + transcript tail to a capacity-pool signal kind. Called
 * unconditionally before deciding, so quota/auth failures open the pool's
 * circuit even when the task itself retries elsewhere (§6.2 step 3).
 *
 * SINGLE SOURCE OF TRUTH (§6.2 step 3): delegates to the pinned §3.1 classifier
 * `signalFromExitReason` over the combined (exitReason + transcript tail) text.
 * A previous divergent local copy missed the canonical SUBSCRIPTION-exhaustion
 * reasons (`quota`, `usage limit`, HTTP 401/403), so an exhausted subscription
 * fell through to record-only `error` and the circuit NEVER opened — the
 * scheduler then re-spawned straight back into the dead subscription. Reusing
 * the authoritative classifier prevents that drift.
 */
function capacityKindFromText(
	exitReason: string | null,
	tail: string,
): "429" | "auth_limit" | "error" {
	const combined = [exitReason ?? "", tail].join(" ");
	return signalFromExitReason(combined);
}

// ---------------------------------------------------------------------------
// triageFailedRun
// ---------------------------------------------------------------------------

/**
 * Triage a terminal-FAILED coder run. Algorithm (§6.2):
 *
 * 1. Preconditions: run exists, state===failed, taskId non-null, task exists,
 *    task.state===coding. Any miss → noop (fail-closed, never force state).
 * 2. attempts = count of kind==="coder" && state==="failed" runs for the task.
 * 3. Capacity feedback (always, before deciding).
 * 4. Decide: attempts > maxRetries → forced human. Else classifier (try/catch).
 * 5. Apply via existing task edges (actor="triage").
 * 6. Audit: emit run.triaged event.
 */
export async function triageFailedRun(
	deps: TriageDeps,
	runId: number,
): Promise<TriageOutcome> {
	const { handle, log, classifier, readTranscriptTail, capacity, maxRetries } = deps;

	// --- Step 1: preconditions ---
	const run = getRun(handle, runId);
	if (run === null) {
		// No event emitted — nothing to triage.
		return {
			applied: "noop",
			decision: { action: "human", reason: "run_not_found" },
			attempts: 0,
		};
	}
	// A terminal-FAILED run is the normal trigger; a `killed` run is the
	// budget-kill path (reapRun makes the run `killed` but never dispositions the
	// task). Both must run triage so a budget-killed task is requeued/escalated
	// rather than orphaned in `coding` forever. Any other state → noop.
	if (run.state !== "failed" && run.state !== "killed") {
		return {
			applied: "noop",
			decision: { action: "human", reason: `run_not_failed: ${run.state}` },
			attempts: 0,
		};
	}
	if (run.taskId === null || run.taskId === undefined) {
		return {
			applied: "noop",
			decision: { action: "human", reason: "run_has_no_task" },
			attempts: 0,
		};
	}
	const task = getTask(handle, run.taskId);
	if (task === null) {
		return {
			applied: "noop",
			decision: { action: "human", reason: "task_not_found" },
			attempts: 0,
		};
	}
	if (task.state !== "coding") {
		// Another actor already moved the task — stand down.
		return {
			applied: "noop",
			decision: { action: "human", reason: `task_not_coding: ${task.state}` },
			attempts: 0,
		};
	}
	if (task.claimedBy !== run.id) {
		// Stale/duplicate failure event for a SUPERSEDED run: the task is now
		// coding under a DIFFERENT (live) run. Applying this old failure would yank
		// state out from under the live agent — stand down (defense-in-depth against
		// event replay / duplicate delivery).
		return {
			applied: "noop",
			decision: { action: "human", reason: `run_superseded: ${task.claimedBy}` },
			attempts: 0,
		};
	}

	// --- Step 2: count prior failed coder runs for this task ---
	const allTaskRuns = listRuns(handle, { taskId: task.id });
	const attempts = allTaskRuns.filter(
		(r) => r.kind === "coder" && r.state === "failed",
	).length;

	// --- Step 3: transcript + capacity feedback (always, before deciding) ---
	const tail = await readTranscriptTail(run);
	const capacityKind = capacityKindFromText(run.exitReason, tail);
	await capacity.observe({
		provider: run.provider,
		kind: capacityKind,
		detail: run.exitReason ?? undefined,
	});

	// --- Step 4: decide ---
	let decision: TriageDecision;
	if (attempts > maxRetries) {
		// Retries exhausted — escalate without consulting classifier.
		decision = { action: "human", reason: "retries_exhausted" };
	} else {
		try {
			const raw = await classifier({
				runId,
				taskId: task.id,
				provider: run.provider,
				exitReason: run.exitReason ?? null,
				transcriptTail: tail,
				attempt: attempts,
				maxRetries,
			});
			// Validate the classifier returned a known action (fail-closed on unknown).
			if (raw.action !== "retry" && raw.action !== "reassign" && raw.action !== "human") {
				decision = { action: "human", reason: "classifier_failed" };
			} else {
				decision = raw;
			}
		} catch {
			decision = { action: "human", reason: "classifier_failed" };
		}
	}

	// --- Step 5: apply ---
	let applied: TriageOutcome["applied"] = "noop";

	if (decision.action === "retry" || decision.action === "reassign") {
		// requeue: coding→failed (coder_failed) → failed→backlog (demote) → recomputeReadiness
		const toFailed = await transitionTask(handle, log, {
			taskId: task.id,
			to: "failed",
			expectedFrom: "coding",
			actor: "triage",
		});

		if (toFailed.ok) {
			const toBacklog = await transitionTask(handle, log, {
				taskId: task.id,
				to: "backlog",
				expectedFrom: "failed",
				actor: "triage",
			});

			if (toBacklog.ok) {
				// Promote to ready if all deps are merged (they were when it was first claimed).
				await recomputeReadiness(handle, log, task.projectId);
				applied = "requeued";
			} else {
				// Lost race on failed→backlog — noop tolerated per §6.2.
				applied = "noop";
			}
		} else {
			// Lost race on coding→failed — noop tolerated per §6.2.
			applied = "noop";
		}
	} else {
		// human: coding→needs_human (gate_blocked edge; actor disambiguates in audit log)
		const toHuman = await transitionTask(handle, log, {
			taskId: task.id,
			to: "needs_human",
			expectedFrom: "coding",
			actor: "triage",
		});
		applied = toHuman.ok ? "needs_human" : "noop";
	}

	// --- Step 6: audit event (always emitted, even on noop) ---
	await log.emitEvent({
		taskId: task.id,
		runId,
		projectId: task.projectId,
		kind: "run.triaged",
		payload: {
			runId,
			taskId: task.id,
			provider: run.provider,
			action: decision.action,
			reason: decision.reason,
			attempts,
			applied,
		},
	});

	return { applied, decision, attempts };
}
