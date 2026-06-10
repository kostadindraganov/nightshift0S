/**
 * Run state machine (docs/SPEC-STATE-MACHINES.md §2 — BINDING).
 *
 * The transition table is a 1:1 transcription of the spec: every legal edge
 * appears exactly once with its named trigger. Terminal states are succeeded,
 * failed, killed, interrupted — no outgoing edges.
 *
 * `transitionRun` is the ONLY way a run changes state:
 *   - illegal from→to pairs are rejected BEFORE touching the DB;
 *   - the state change is a guarded UPDATE (`… WHERE id=:id AND state=:from`,
 *     §6) inside one serialized writer-queue link; 0 rows means a concurrent
 *     actor won — returned as `{ok:false, reason:'lost_race'}`, never thrown;
 *   - the `run.state_changed` event row is INSERTed in the SAME link
 *     (EventLog.emitInWriter) so invariant 5 holds: every state change has an
 *     event row, in commit order.
 *
 * Special edges carry extra columns on the run row:
 *   - queued→starting sets startedAt (wall-clock start anchor for the run);
 *     may also set tmuxSession, worktreePath, homePath;
 *   - starting→running may set sessionId;
 *   - finishing→succeeded|failed sets exitReason, tokensIn, tokensOut,
 *     costUsd, priced, endedAt;
 *   - any-active→killed and queued|starting→interrupted set endedAt;
 *   - all terminal transitions set endedAt.
 */

import { and, eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { RUN_STATES, RUN_TERMINAL_STATES, type RunState } from "../db/columns.ts";
import { runs, type RunRow } from "../db/schema.ts";
import { enqueueWrite } from "../db/writer.ts";
import type { EventLog } from "../events/events.ts";

/** Event kind emitted for every run state change (invariant 5). */
export const RUN_STATE_CHANGED = "run.state_changed";

export function isTerminalRunState(state: RunState): boolean {
	return (RUN_TERMINAL_STATES as readonly RunState[]).includes(state);
}

export interface RunTransition {
	readonly from: RunState;
	readonly to: RunState;
	/** Named trigger from the spec table (audit payloads carry it). */
	readonly trigger: string;
}

/** Non-terminal states — used to expand the "any active → killed" edge. */
const ACTIVE_RUN_STATES = RUN_STATES.filter((s) => !isTerminalRunState(s));

/**
 * SPEC-STATE-MACHINES §2, row for row.
 * The "any active → killed" and "any active → interrupted" blocks are
 * expanded at the end (the spec §2 prose: "every run in a non-terminal state
 * whose tmux session is gone → interrupted" — boot reconciliation).
 */
export const RUN_TRANSITIONS: readonly RunTransition[] = [
	// Normal lifecycle forward path.
	{ from: "queued", to: "starting", trigger: "spawn_acquired" },
	{ from: "starting", to: "running", trigger: "session_start" },
	// Hook-driven pauses.
	{ from: "running", to: "awaiting_input", trigger: "blocking_tool" },
	{ from: "awaiting_input", to: "running", trigger: "tool_reply" },
	// Background agents handoff.
	{ from: "running", to: "background_waiting", trigger: "interim_stop_background" },
	{ from: "background_waiting", to: "running", trigger: "subagent_returning" },
	{ from: "background_waiting", to: "finishing", trigger: "all_subagents_returned" },
	// Completion.
	{ from: "running", to: "finishing", trigger: "stop_hook" },
	// Terminal outcomes from finishing.
	{ from: "finishing", to: "succeeded", trigger: "exit_clean" },
	{ from: "finishing", to: "failed", trigger: "exit_error" },
	// Watchdog paths directly from running (missed stop hook, per-step timeout).
	{ from: "running", to: "succeeded", trigger: "watchdog_clean" },
	{ from: "running", to: "failed", trigger: "watchdog_error" },
	// Startup reconciliation: process/tmux gone. Per SPEC §2 prose, ANY
	// non-terminal run whose session vanished across a restart is `interrupted`
	// (distinct from `killed`, which means we deliberately reaped it).
	...ACTIVE_RUN_STATES.map(
		(from): RunTransition => ({ from, to: "interrupted", trigger: "startup_reconcile" }),
	),
	// Any active (non-terminal) state → killed: manual stop / budget / cancel.
	...ACTIVE_RUN_STATES.map(
		(from): RunTransition => ({ from, to: "killed", trigger: "kill" }),
	),
];

export function findRunTransition(from: RunState, to: RunState): RunTransition | undefined {
	return RUN_TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function isLegalRunTransition(from: RunState, to: RunState): boolean {
	return findRunTransition(from, to) !== undefined;
}

// ---------------------------------------------------------------------------
// transitionRun

/** Optional extra fields carried on specific edges. */
export interface RunTransitionExtra {
	/** starting→running (and queued→starting, if known early). */
	readonly sessionId?: string;
	/** queued→starting: tmux session name. */
	readonly tmuxSession?: string;
	/** queued→starting: path to the git worktree. */
	readonly worktreePath?: string;
	/** queued→starting: per-task home directory. */
	readonly homePath?: string;
	/** queued→starting: wall-clock start timestamp (ISO8601). If omitted, now() is used. */
	readonly startedAt?: string;
	/** finishing→succeeded|failed: classified exit reason string. */
	readonly exitReason?: string;
	/** finishing→succeeded|failed: input token count. */
	readonly tokensIn?: number;
	/** finishing→succeeded|failed: output token count. */
	readonly tokensOut?: number;
	/** finishing→succeeded|failed: USD cost reported by provider. */
	readonly costUsd?: number;
	/** finishing→succeeded|failed: cost telemetry proven flag. */
	readonly priced?: boolean;
	/** Terminal transitions: wall-clock end timestamp (ISO8601). If omitted, now() is used. */
	readonly endedAt?: string;
}

export interface RunTransitionInput {
	readonly runId: number;
	readonly to: RunState;
	/**
	 * Optimistic-concurrency guard. When given, the UPDATE is guarded on this
	 * exact state and a 0-row result means a lost race. When omitted, the
	 * current state is read inside the same writer link.
	 */
	readonly expectedFrom?: RunState;
	/** Who drove the change — recorded in the event payload. */
	readonly actor: string;
	readonly extra?: RunTransitionExtra;
}

export type RunTransitionResult =
	| { ok: true; run: RunRow; from: RunState }
	| { ok: false; reason: "illegal" | "lost_race" | "not_found" };

export function transitionRun(
	handle: DbHandle,
	log: EventLog,
	input: RunTransitionInput,
): Promise<RunTransitionResult> {
	const { runId, to, expectedFrom, actor, extra } = input;

	// Fast-reject unknown states before touching the DB.
	if (!RUN_STATES.includes(to)) {
		return Promise.resolve({ ok: false, reason: "illegal" });
	}
	if (expectedFrom !== undefined && !RUN_STATES.includes(expectedFrom)) {
		return Promise.resolve({ ok: false, reason: "illegal" });
	}
	// When the caller pins the from-state we can reject illegal pairs cheaply.
	if (expectedFrom !== undefined && !isLegalRunTransition(expectedFrom, to)) {
		return Promise.resolve({ ok: false, reason: "illegal" });
	}

	return enqueueWrite((): RunTransitionResult => {
		const db = handle.db;
		const current = db.select().from(runs).where(eq(runs.id, runId)).get();
		if (!current) return { ok: false, reason: "not_found" };

		const from = expectedFrom ?? current.state;
		const edge = findRunTransition(from, to);
		if (!edge) return { ok: false, reason: "illegal" };

		const now = new Date().toISOString();
		const patch: Partial<typeof runs.$inferInsert> = { state: to };

		// queued→starting: anchor the wall-clock start.
		if (from === "queued" && to === "starting") {
			patch.startedAt = extra?.startedAt ?? now;
			if (extra?.tmuxSession !== undefined) patch.tmuxSession = extra.tmuxSession;
			if (extra?.worktreePath !== undefined) patch.worktreePath = extra.worktreePath;
			if (extra?.homePath !== undefined) patch.homePath = extra.homePath;
			if (extra?.sessionId !== undefined) patch.sessionId = extra.sessionId;
		}

		// starting→running: provider session established.
		if (from === "starting" && to === "running") {
			if (extra?.sessionId !== undefined) patch.sessionId = extra.sessionId;
		}

		// finishing→succeeded|failed: cost/exit telemetry.
		if (from === "finishing" && (to === "succeeded" || to === "failed")) {
			if (extra?.exitReason !== undefined) patch.exitReason = extra.exitReason;
			if (extra?.tokensIn !== undefined) patch.tokensIn = extra.tokensIn;
			if (extra?.tokensOut !== undefined) patch.tokensOut = extra.tokensOut;
			if (extra?.costUsd !== undefined) patch.costUsd = extra.costUsd;
			if (extra?.priced !== undefined) patch.priced = extra.priced;
		}

		// Any terminal transition: anchor the end time.
		if (isTerminalRunState(to)) {
			patch.endedAt = extra?.endedAt ?? now;
		}

		// The canonical guarded UPDATE (§6): 0 rows ⇒ concurrent actor moved the
		// run first ⇒ no-op lost race. Never throw, never retry.
		const updated = db
			.update(runs)
			.set(patch)
			.where(and(eq(runs.id, runId), eq(runs.state, from)))
			.returning()
			.get();
		if (!updated) return { ok: false, reason: "lost_race" };

		// Same writer link as the UPDATE: invariant 5 cannot be violated.
		log.emitInWriter({
			runId,
			taskId: current.taskId ?? undefined,
			kind: RUN_STATE_CHANGED,
			payload: { runId, from, to, actor, trigger: edge.trigger },
		});

		return { ok: true, run: updated, from };
	});
}
