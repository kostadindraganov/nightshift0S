/**
 * Task state machine (docs/SPEC-STATE-MACHINES.md §1 — BINDING).
 *
 * The transition table below is a 1:1 transcription of the spec table:
 * every legal edge appears exactly once with its named trigger; everything
 * else is illegal. Terminal states are `done` and `cancelled` — `failed` is
 * NOT terminal (it demotes back to backlog, localforge pattern).
 *
 * `transitionTask` is the ONLY way a task changes state:
 *   - illegal from→to pairs are rejected BEFORE touching the DB;
 *   - the state change is a guarded UPDATE (`… WHERE id=:id AND state=:from`,
 *     §6) inside one serialized writer-queue link; a 0-row update means a
 *     concurrent actor won — returned as `{ok:false, reason:'lost_race'}`,
 *     never thrown, never blindly retried;
 *   - the `task.state_changed` event row is INSERTed in the SAME link
 *     (`EventLog.emitInWriter`) so invariant 5 holds: every state change has
 *     an event row, in commit order.
 *
 * Special edges carry extra columns:
 *   - ready→coding (claim) sets `claimed_by` (+ optional base_sha/branch);
 *   - merging→done sets `merge_sha` — and is the ONLY writer of merge_sha,
 *     enforcing invariant 3 in both directions (done requires merge_sha;
 *     merge_sha only set by this edge);
 *   - failed→backlog (demote) bumps priority past the project max (localforge);
 *   - backlog→ready is marked systemOnly: legal in the machine, but driven by
 *     `recomputeReadiness` (./dependencies.ts), not by API callers — the HTTP
 *     layer rejects it.
 */

import { and, eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { TASK_STATES, type TaskState } from "../db/columns.ts";
import { tasks, type TaskRow } from "../db/schema.ts";
import { enqueueWrite } from "../db/writer.ts";
import type { EventLog } from "../events/events.ts";
import { ValidationError } from "./tasks.ts";

/** Event kind emitted for every task state change (invariant 5). */
export const TASK_STATE_CHANGED = "task.state_changed";

/** Terminal task states — no outgoing edges, not even to cancelled. */
export const TASK_TERMINAL_STATES = ["done", "cancelled"] as const satisfies readonly TaskState[];

export function isTerminalTaskState(state: TaskState): boolean {
	return (TASK_TERMINAL_STATES as readonly TaskState[]).includes(state);
}

export interface TaskTransition {
	readonly from: TaskState;
	readonly to: TaskState;
	/** Named trigger from the spec table (audit payloads carry it). */
	readonly trigger: string;
	/** Driven by the system (readiness recompute), not invokable via the API. */
	readonly systemOnly?: boolean;
}

const NON_TERMINAL_STATES = TASK_STATES.filter((s) => !isTerminalTaskState(s));

/** SPEC-STATE-MACHINES §1, row for row. `* (non-terminal) → cancelled` is expanded last. */
export const TASK_TRANSITIONS: readonly TaskTransition[] = [
	{ from: "draft", to: "backlog", trigger: "promote" },
	{ from: "backlog", to: "ready", trigger: "deps_merged", systemOnly: true },
	{ from: "ready", to: "coding", trigger: "claim" },
	{ from: "coding", to: "review", trigger: "coder_succeeded" },
	{ from: "coding", to: "failed", trigger: "coder_failed" },
	// Coder run succeeded but a pre-PR gate blocked (secret scan / CI red /
	// stale-base block / PR open failed) — escalate instead of advancing.
	{ from: "coding", to: "needs_human", trigger: "gate_blocked" },
	{ from: "review", to: "coding", trigger: "revise" },
	{ from: "review", to: "approved", trigger: "approve" },
	{ from: "review", to: "needs_human", trigger: "escalate" },
	{ from: "approved", to: "merging", trigger: "merge_start" },
	{ from: "merging", to: "done", trigger: "merge_confirmed" },
	{ from: "merging", to: "needs_human", trigger: "merge_blocked" },
	{ from: "failed", to: "backlog", trigger: "demote" },
	{ from: "needs_human", to: "coding", trigger: "human_resume_coding" },
	{ from: "needs_human", to: "merging", trigger: "human_force_merge" },
	// Any non-terminal → cancelled (covers needs_human → cancelled too).
	...NON_TERMINAL_STATES.map(
		(from): TaskTransition => ({ from, to: "cancelled", trigger: "cancel" }),
	),
];

export function findTransition(from: TaskState, to: TaskState): TaskTransition | undefined {
	return TASK_TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function isLegalTransition(from: TaskState, to: TaskState): boolean {
	return findTransition(from, to) !== undefined;
}

// ---------------------------------------------------------------------------
// transitionTask

export interface TransitionExtra {
	/** ready→coding: claiming run id (FK runs.id). */
	readonly claimedBy?: number | null;
	/** ready→coding: merge-base recorded at claim (§3.12.12). */
	readonly baseSha?: string;
	/** ready→coding: `ns/<task_id>-<slug>` branch name. */
	readonly branch?: string;
	/** merging→done: REQUIRED — forge-confirmed merge commit (invariant 3). */
	readonly mergeSha?: string;
}

export interface TransitionInput {
	readonly taskId: number;
	readonly to: TaskState;
	/**
	 * Optimistic-concurrency guard. When given, the UPDATE is guarded on this
	 * exact state and a 0-row result is a lost race. When omitted, the current
	 * state is read inside the same writer link (no race window).
	 */
	readonly expectedFrom?: TaskState;
	/** Who drove the change — recorded in the event payload. */
	readonly actor: string;
	readonly extra?: TransitionExtra;
}

export type TransitionResult =
	| { ok: true; task: TaskRow; from: TaskState }
	| { ok: false; reason: "illegal" | "lost_race" | "not_found" };

export function transitionTask(
	handle: DbHandle,
	log: EventLog,
	input: TransitionInput,
): Promise<TransitionResult> {
	const { taskId, to, expectedFrom, actor, extra } = input;
	if (!TASK_STATES.includes(to)) {
		throw new ValidationError(`Invalid target state '${String(to)}'`);
	}
	if (expectedFrom !== undefined && !TASK_STATES.includes(expectedFrom)) {
		throw new ValidationError(`Invalid expected_from state '${String(expectedFrom)}'`);
	}
	// Invariant 3 ("done requires merge_sha") is a 400-class caller bug — but it
	// must be checked AFTER legality, never before: an illegal edge to 'done'
	// (e.g. draft→done) is a 409 illegal_transition, not a 400 missing-field.
	const requireMergeSha = (): void => {
		if (to === "done" && (typeof extra?.mergeSha !== "string" || extra.mergeSha.length === 0)) {
			throw new ValidationError("Transition to 'done' requires a non-empty merge_sha");
		}
	};

	// Illegal pairs are rejected before any DB work when the caller pinned the
	// from-state; the unpinned path checks inside the link after reading state.
	if (expectedFrom !== undefined) {
		if (!isLegalTransition(expectedFrom, to)) {
			return Promise.resolve({ ok: false, reason: "illegal" });
		}
		// Edge is legal — now a missing merge_sha is a genuine 400.
		requireMergeSha();
	}

	return enqueueWrite((): TransitionResult => {
		const db = handle.db;
		const current = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
		if (!current) return { ok: false, reason: "not_found" };
		const from = expectedFrom ?? current.state;
		const edge = findTransition(from, to);
		if (!edge) return { ok: false, reason: "illegal" };

		// Unpinned path: the edge's legality is only known here (after reading
		// current state). Enforce merge_sha now — after a confirmed-legal edge,
		// never before. (The pinned path already checked it above.)
		if (expectedFrom === undefined) requireMergeSha();

		const patch: Partial<typeof tasks.$inferInsert> = {
			state: to,
			updatedAt: new Date().toISOString(),
		};
		if (edge.trigger === "claim") {
			patch.claimedBy = extra?.claimedBy ?? null;
			if (extra?.baseSha !== undefined) patch.baseSha = extra.baseSha;
			if (extra?.branch !== undefined) patch.branch = extra.branch;
		}
		// Invariant 3, direction "merge_sha only set at done": this is the only
		// place in the codebase that writes tasks.merge_sha.
		if (to === "done") patch.mergeSha = extra?.mergeSha;
		if (edge.trigger === "demote") {
			// localforge demotion: land strictly after every sibling so other
			// backlog items are attempted before the orchestrator retries this one.
			const priorities = db
				.select({ priority: tasks.priority })
				.from(tasks)
				.where(eq(tasks.projectId, current.projectId))
				.all();
			const currentMax = priorities.reduce((acc, r) => Math.max(acc, r.priority), 0);
			patch.priority = Math.max(currentMax + 1, current.priority + 1);
		}

		// The canonical guarded UPDATE (§6): 0 rows ⇒ a concurrent actor moved
		// the task first ⇒ no-op lost race. Never throw, never retry.
		const updated = db
			.update(tasks)
			.set(patch)
			.where(and(eq(tasks.id, taskId), eq(tasks.state, from)))
			.returning()
			.get();
		if (!updated) return { ok: false, reason: "lost_race" };

		// Same writer link as the UPDATE: invariant 5 (every state change has an
		// event row) cannot be violated by a crash between the two writes being
		// reordered — they commit in this exact order or the caller sees a throw.
		log.emitInWriter({
			projectId: current.projectId,
			taskId,
			kind: TASK_STATE_CHANGED,
			payload: { taskId, from, to, actor, trigger: edge.trigger },
		});
		return { ok: true, task: updated, from };
	});
}
