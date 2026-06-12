/**
 * WHY: The append-only task thread (BLUEPRINT §3.12.10) is the immutable audit
 * record of the coder↔reviewer ping-pong: messages, findings, rebuttals,
 * verdicts, system/human notes. Two invariants make it trustworthy and they
 * BOTH live inside one serialized write link per append:
 *   1. `seq` is allocated as max(seq)+1 for the task INSIDE `enqueueWrite`, so
 *      it is gap-free and strictly monotonic even under concurrent appends
 *      (the DB is the counter — same discipline as EventLog).
 *   2. The payload is run through `redactPayload` BEFORE the INSERT, so an
 *      unredacted secret can never be persisted (§3.12.28). The global
 *      `thread.appended` event carries only light metadata, never the payload.
 * `idempotencyKey` dedupes hook/retry double-delivery: a key hit returns the
 * existing row and emits nothing. Findings are anchored separately and their
 * resolution lifecycle is a guarded UPDATE (open|rebutted → terminal/rebutted).
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import {
	findings,
	tasks,
	threadEvents,
	type FindingRow,
	type ThreadEventRow,
} from "../db/schema.ts";
import type {
	FindingResolutionState,
	FindingSeverity,
	ThreadEventKind,
} from "../db/columns.ts";
import { enqueueWrite } from "../db/writer.ts";
import { redactPayload } from "./redaction.ts";

/** Global event kind emitted on every successful thread append. */
export const THREAD_APPENDED = "thread.appended";

/** Global event kind emitted when a finding's resolution state changes. */
export const FINDING_UPDATED = "finding.updated";

// ---------------------------------------------------------------------------
// appendThreadEvent
// ---------------------------------------------------------------------------

export interface AppendThreadEventInput {
	taskId: number;
	kind: ThreadEventKind;
	actor: string;
	round: number;
	runId?: number | null;
	idempotencyKey?: string;
	payload: unknown;
	artifactRefs?: string[];
}

/**
 * Append one event to the task thread. Idempotency check, seq allocation,
 * redaction, INSERT, and the `thread.appended` emit ALL run in one serialized
 * write link so seq is race-free and the event publish order matches seq order.
 */
export function appendThreadEvent(
	handle: DbHandle,
	log: EventLog,
	input: AppendThreadEventInput,
): Promise<ThreadEventRow> {
	return enqueueWrite(() => {
		// 1. Idempotency: a key hit returns the existing row, emits NOTHING.
		if (input.idempotencyKey !== undefined) {
			const existing = handle.db
				.select()
				.from(threadEvents)
				.where(eq(threadEvents.idempotencyKey, input.idempotencyKey))
				.get();
			if (existing) return existing;
		}

		// 2. seq = max(seq) for this task + 1 (DB is the counter).
		const next =
			(handle.db
				.select({ max: sql<number>`coalesce(max(${threadEvents.seq}), 0)` })
				.from(threadEvents)
				.where(eq(threadEvents.taskId, input.taskId))
				.get()?.max ?? 0) + 1;

		// 3. Redact BEFORE persist — the unredacted payload never reaches INSERT.
		const { redacted, value } = redactPayload(input.payload);

		// 4. INSERT.
		const row = handle.db
			.insert(threadEvents)
			.values({
				taskId: input.taskId,
				seq: next,
				kind: input.kind,
				actor: input.actor,
				round: input.round,
				runId: input.runId ?? null,
				idempotencyKey: input.idempotencyKey ?? null,
				payloadJson: JSON.stringify(value),
				artifactRefs:
					input.artifactRefs !== undefined ? JSON.stringify(input.artifactRefs) : null,
				redacted,
				createdAt: new Date().toISOString(),
			})
			.returning()
			.get();

		// 5. Emit the global event (light payload) in the SAME link.
		const projectId =
			handle.db
				.select({ projectId: tasks.projectId })
				.from(tasks)
				.where(eq(tasks.id, input.taskId))
				.get()?.projectId ?? null;
		log.emitInWriter({
			projectId,
			taskId: input.taskId,
			runId: input.runId ?? null,
			kind: THREAD_APPENDED,
			payload: {
				taskId: input.taskId,
				seq: next,
				kind: input.kind,
				round: input.round,
				actor: input.actor,
			},
		});

		return row;
	});
}

/** All thread events for a task, oldest first (seq ASC). */
export function getThread(handle: DbHandle, taskId: number): ThreadEventRow[] {
	return handle.db
		.select()
		.from(threadEvents)
		.where(eq(threadEvents.taskId, taskId))
		.orderBy(asc(threadEvents.seq))
		.all();
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export interface AddFindingInput {
	taskId: number;
	round: number;
	runId?: number | null;
	severity: FindingSeverity;
	confidence: number;
	commitSha: string;
	filePathOld?: string | null;
	filePathNew?: string | null;
	hunkContext?: string | null;
	description: string;
	suggestion?: string | null;
}

/** Insert an anchored finding; resolution_state defaults to "open". */
export function addFinding(handle: DbHandle, input: AddFindingInput): Promise<FindingRow> {
	return enqueueWrite(() =>
		handle.db
			.insert(findings)
			.values({
				taskId: input.taskId,
				round: input.round,
				runId: input.runId ?? null,
				severity: input.severity,
				confidence: input.confidence,
				commitSha: input.commitSha,
				filePathOld: input.filePathOld ?? null,
				filePathNew: input.filePathNew ?? null,
				hunkContext: input.hunkContext ?? null,
				description: input.description,
				suggestion: input.suggestion ?? null,
			})
			.returning()
			.get(),
	);
}

/** Findings for a task, optionally filtered to one round, ordered by id ASC. */
export function listFindings(handle: DbHandle, taskId: number, round?: number): FindingRow[] {
	const clause =
		round === undefined
			? eq(findings.taskId, taskId)
			: and(eq(findings.taskId, taskId), eq(findings.round, round));
	return handle.db
		.select()
		.from(findings)
		.where(clause)
		.orderBy(asc(findings.id))
		.all();
}

export interface UpdateFindingResolutionInput {
	findingId: number;
	/** Target resolution; "open" is rejected (cannot reopen). */
	resolutionState: FindingResolutionState;
	resolvedRound: number;
}

/**
 * Guarded resolution transition: only findings currently in `open` or
 * `rebutted` may move (SPEC §3). A target of "open" is rejected (you cannot
 * reopen). Returns null when the guard fails (not found / already terminal),
 * otherwise the updated row. Emits `finding.updated` in the same write link.
 */
export function updateFindingResolution(
	handle: DbHandle,
	log: EventLog,
	input: UpdateFindingResolutionInput,
): Promise<FindingRow | null> {
	return enqueueWrite(() => {
		// Fail-closed: never reopen.
		if (input.resolutionState === "open") return null;

		const row = handle.db
			.update(findings)
			.set({
				resolutionState: input.resolutionState,
				resolvedRound: input.resolvedRound,
			})
			.where(
				and(
					eq(findings.id, input.findingId),
					inArray(findings.resolutionState, ["open", "rebutted"]),
				),
			)
			.returning()
			.get();

		if (!row) return null;

		log.emitInWriter({
			projectId: null,
			taskId: row.taskId,
			runId: row.runId,
			kind: FINDING_UPDATED,
			payload: {
				findingId: row.id,
				taskId: row.taskId,
				resolutionState: input.resolutionState,
				resolvedRound: input.resolvedRound,
			},
		});

		return row;
	});
}

// ---------------------------------------------------------------------------
// Structural bundle (B3's port mirrors this verbatim)
// ---------------------------------------------------------------------------

export interface ThreadApi {
	appendThreadEvent: typeof appendThreadEvent;
	getThread: typeof getThread;
	addFinding: typeof addFinding;
	listFindings: typeof listFindings;
	updateFindingResolution: typeof updateFindingResolution;
}

export const threadApi: ThreadApi = {
	appendThreadEvent,
	getThread,
	addFinding,
	listFindings,
	updateFindingResolution,
};
