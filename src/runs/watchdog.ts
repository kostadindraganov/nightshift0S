/**
 * Run watchdog — ADR-0019 timeouts + transcript inspection.
 *
 * WHY: A run can go silent in two ways:
 *   1. A completion signal was observed (Stop hook received, run→finishing) but
 *      the process is stuck in a gh/MCP subprocess and never exits cleanly.
 *      ADR-0019: after a short COMPLETION timeout (default 60 s) we
 *      force-complete the run as succeeded and warn — do not turn finished work
 *      into a failure because a subprocess hung.
 *   2. The run has been silent past the IDLE timeout (default 10 min) with no
 *      completion signal. We inspect the transcript tail to classify:
 *        - api_error pattern  → watchdog_fail  (running→failed)
 *        - normal assistant text → watchdog_succeed (running→succeeded, missed
 *          Stop hook)
 *        - unknown (empty / ambiguous) → no action (let the caller retry later)
 *
 * All dependencies (DB handle, event log, clock, transcript reader, timeout
 * values) are injected so the module is fully testable without real timers or
 * the filesystem.
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { RunRow } from "../db/schema.ts";
import { transitionRun } from "./transitions.ts";

// ---------------------------------------------------------------------------
// Public types

export interface WatchdogDeps {
	handle: DbHandle;
	log: EventLog;
	/** Returns the current epoch in milliseconds (injectable for tests). */
	now(): number;
	/**
	 * Read the last N lines of the run's transcript (injectable for tests).
	 * Should never throw — return an empty string on any I/O error.
	 */
	readTranscriptTail(run: RunRow): Promise<string>;
	/** Idle timeout in milliseconds (default 600_000 = 10 min). */
	idleMs?: number;
	/** Completion signal timeout in milliseconds (default 60_000 = 1 min). */
	completionMs?: number;
}

/**
 * The decision `evaluateRun` reached — documented so callers can log/audit it.
 */
export type WatchdogAction =
	| "none"
	| "force_succeed"    // completion timeout fired → ADR-0019 force-complete
	| "watchdog_succeed" // idle + transcript looks normal → missed stop hook
	| "watchdog_fail";   // idle + transcript shows api_error

export interface EvaluateResult {
	action: WatchdogAction;
	reason: string;
}

// ---------------------------------------------------------------------------
// Transcript classification

/** Known api-error patterns (case-insensitive substring match). */
const API_ERROR_PATTERNS = [
	"overloaded_error",
	"rate_limit",
	"api error",
	"500 internal server",
	"503 service unavailable",
	"connection reset",
	"econnrefused",
	"authentication_error",
	"invalid_api_key",
] as const;

/**
 * Classify the last lines of a run's transcript.
 *
 * "api_error"  — transcript ends with a recognisable API/network error;
 *                the run should be marked failed.
 * "normal"     — transcript ends with what looks like a normal assistant turn;
 *                the Stop hook was probably missed and the run succeeded.
 * "unknown"    — we cannot determine the outcome; watchdog takes no action.
 */
export function classifySilentTranscript(tail: string): "api_error" | "normal" | "unknown" {
	const trimmed = tail.trim();
	if (trimmed.length === 0) return "unknown";

	const lower = trimmed.toLowerCase();
	for (const pattern of API_ERROR_PATTERNS) {
		if (lower.includes(pattern)) return "api_error";
	}

	// Heuristic: a normal assistant turn has prose content (letters/digits,
	// multiple words) that is not exclusively JSON scaffolding or error noise.
	// We look for at least 20 non-whitespace characters of human-readable text.
	const nonWs = trimmed.replace(/\s+/g, "");
	if (nonWs.length >= 20) return "normal";

	return "unknown";
}

// ---------------------------------------------------------------------------
// Per-step timeout descriptor (ADR-0001)

/** Named per-step timeout for structured logging and future policy enforcement. */
export interface StepTimeout {
	readonly name: string;
	readonly limitMs: number;
	readonly runId: number;
}

// ---------------------------------------------------------------------------
// Core evaluation + transition

const DEFAULT_IDLE_MS = 600_000;       // 10 minutes
const DEFAULT_COMPLETION_MS = 60_000;  // 1 minute

/**
 * Evaluate a single run against the watchdog thresholds and, if warranted,
 * apply the appropriate state transition.
 *
 * @param deps         - Injected dependencies (handle, log, clock, reader, timeouts)
 * @param run          - The RunRow to evaluate; MUST be in `running` state.
 * @param lastActivityMs - Epoch ms of the last observed activity for this run.
 * @param completionSignalAtMs - Epoch ms when a completion signal was first seen,
 *                               or null if none has been observed yet.
 */
export async function evaluateRun(
	deps: WatchdogDeps,
	run: RunRow,
	lastActivityMs: number,
	completionSignalAtMs: number | null,
): Promise<EvaluateResult> {
	const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
	const completionMs = deps.completionMs ?? DEFAULT_COMPLETION_MS;
	const now = deps.now();

	// --- Branch 1: completion signal received, check completion timeout ---
	if (completionSignalAtMs !== null) {
		const elapsed = now - completionSignalAtMs;
		if (elapsed > completionMs) {
			// ADR-0019: force-complete as succeeded; warn so the operator is aware.
			// The run is in `running` state; we cannot go directly to `finishing`
			// and then `succeeded` in a single evaluateRun call without two
			// transitions, but per the spec the watchdog path running→succeeded is
			// a legal edge (trigger: watchdog_clean). We use that direct edge and
			// record the force-complete warning via an extra event.
			const reason = `completion_timeout:${elapsed}ms>completionMs:${completionMs}ms`;

			// Apply the transition.
			const result = await transitionRun(deps.handle, deps.log, {
				runId: run.id,
				to: "succeeded",
				expectedFrom: "running",
				actor: "watchdog",
				extra: { exitReason: reason },
			});

			if (!result.ok) {
				// Lost the race to another actor — benign; report none.
				return { action: "none", reason: `lost_race_on_force_succeed:${result.reason}` };
			}

			// Emit a separate warn event (ADR-0019: "warn, do not fail").
			await deps.log.emitEvent({
				runId: run.id,
				taskId: run.taskId ?? undefined,
				kind: "run.watchdog_warn",
				payload: {
					runId: run.id,
					message: "ADR-0019: completion timeout exceeded; force-completed as succeeded",
					elapsedMs: elapsed,
					completionMs,
				},
			});

			return { action: "force_succeed", reason };
		}
		// Completion signal seen but timeout not yet elapsed — nothing to do.
		return { action: "none", reason: "completion_signal_within_timeout" };
	}

	// --- Branch 2: no completion signal, check idle timeout ---
	const idleElapsed = now - lastActivityMs;
	if (idleElapsed <= idleMs) {
		return { action: "none", reason: "within_idle_timeout" };
	}

	// Idle timeout exceeded — inspect the transcript.
	const tail = await deps.readTranscriptTail(run);
	const classification = classifySilentTranscript(tail);

	if (classification === "unknown") {
		return { action: "none", reason: "idle_timeout_exceeded_but_transcript_unknown" };
	}

	if (classification === "api_error") {
		const reason = `watchdog_fail:idle:${idleElapsed}ms>idleMs:${idleMs}ms`;
		const result = await transitionRun(deps.handle, deps.log, {
			runId: run.id,
			to: "failed",
			expectedFrom: "running",
			actor: "watchdog",
			extra: { exitReason: reason },
		});
		if (!result.ok) {
			return { action: "none", reason: `lost_race_on_watchdog_fail:${result.reason}` };
		}
		return { action: "watchdog_fail", reason };
	}

	// classification === "normal"
	const reason = `watchdog_succeed:idle:${idleElapsed}ms>idleMs:${idleMs}ms`;
	const result = await transitionRun(deps.handle, deps.log, {
		runId: run.id,
		to: "succeeded",
		expectedFrom: "running",
		actor: "watchdog",
		extra: { exitReason: reason },
	});
	if (!result.ok) {
		return { action: "none", reason: `lost_race_on_watchdog_succeed:${result.reason}` };
	}
	return { action: "watchdog_succeed", reason };
}
