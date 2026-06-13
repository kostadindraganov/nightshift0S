/**
 * WHY: Transcript browser for a run or task (BLUEPRINT §3.12.16).
 *
 * Two source tables feed a transcript:
 *   - `events`       — the global event log. Rows carry `run_id` or `task_id`
 *                      and a free-form `kind` string. `payload_json` is parsed
 *                      and re-exposed (never the raw string).
 *   - `thread_events` — the append-only task conversation. Rows carry actor,
 *                       round, and idempotency_key. `payload_json` is already
 *                       redacted before persist (§3.12.28); the `redacted` flag
 *                       is passed through verbatim so the caller knows redaction
 *                       happened. We do NOT re-expose the value.
 *
 * Ordering: rows from both tables are merged and sorted by (ts ASC, then by
 * source ASC ["event" < "thread"], then by seq ASC). ISO-8601 string compare
 * is identical to chronological order because the format is left-padded and
 * zero-padded. The (source, seq) tie-break is deterministic even if two rows
 * share the exact same millisecond timestamp.
 *
 * Read-only — no writes, no `enqueueWrite`.
 */

import { and, asc, eq, gt } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { events, threadEvents, type EventRow, type ThreadEventRow } from "../db/schema.ts";

// ---------------------------------------------------------------------------
// Public envelope

export interface TranscriptEvent {
	/** Monotonically assigned during merge; 1-indexed, no gaps. */
	seq: number;
	/** ISO-8601 timestamp from the source row. */
	ts: string;
	/** Which table the row came from. */
	source: "event" | "thread";
	/** Event kind string (e.g. "thread.appended", "run.transition", …). */
	kind: string;
	/** Actor field — only present for thread_events rows. */
	actor?: string;
	/** Run id the event belongs to (from either table). */
	runId?: number | null;
	/** Round — only present for thread_events rows. */
	round?: number | null;
	/** Idempotency key — only present for thread_events rows. */
	idempotencyKey?: string | null;
	/**
	 * True when the payload was redacted before persist (thread_events only).
	 * Absent for global events (they are never redacted).
	 */
	redacted?: boolean;
	/**
	 * Parsed payload. For global events: `payload_json` parsed via JSON.parse
	 * (null on parse failure). For thread_events: `payload_json` parsed — the
	 * value is already post-redaction and is passed through as-is.
	 */
	payload: unknown;
}

// ---------------------------------------------------------------------------
// Normalization helpers

/** Normalize one global `events` row into the common envelope. */
function normalizeEventRow(row: EventRow): Omit<TranscriptEvent, "seq"> {
	let payload: unknown = null;
	try {
		payload = JSON.parse(row.payloadJson);
	} catch {
		// Malformed JSON in older rows — surface as null rather than throwing.
		payload = null;
	}
	return {
		ts: row.ts,
		source: "event",
		kind: row.kind,
		runId: row.runId ?? null,
		payload,
	};
}

/** Normalize one `thread_events` row into the common envelope. */
function normalizeThreadRow(row: ThreadEventRow): Omit<TranscriptEvent, "seq"> {
	let payload: unknown = null;
	try {
		// The value is already redacted at persist time (§3.12.28); parse as-is.
		payload = JSON.parse(row.payloadJson);
	} catch {
		payload = null;
	}
	return {
		ts: row.createdAt,
		source: "thread",
		kind: row.kind,
		actor: row.actor,
		runId: row.runId ?? null,
		round: row.round,
		idempotencyKey: row.idempotencyKey ?? null,
		redacted: row.redacted,
		payload,
	};
}

// ---------------------------------------------------------------------------
// Merge + sort

/**
 * Merge two sets of normalized rows and assign final 1-indexed `seq`.
 *
 * Sort key: (ts ASC, source ASC ["event" < "thread"], originalSeq ASC).
 * ISO-8601 strings are lexicographically equivalent to chronological order.
 * The (source, originalSeq) secondary key is deterministic: global event rows
 * use their own monotonic `seq`; thread_event rows use their per-task `seq`.
 */
function mergeAndSort(
	eventRows: Array<{ normalized: Omit<TranscriptEvent, "seq">; originalSeq: number }>,
	threadRows: Array<{ normalized: Omit<TranscriptEvent, "seq">; originalSeq: number }>,
): TranscriptEvent[] {
	const all: Array<{ normalized: Omit<TranscriptEvent, "seq">; originalSeq: number }> = [
		...eventRows,
		...threadRows,
	];

	all.sort((a, b) => {
		// Primary: timestamp (ISO string compare == chronological order).
		const tsCmp = a.normalized.ts.localeCompare(b.normalized.ts);
		if (tsCmp !== 0) return tsCmp;
		// Secondary: source — "event" < "thread" (alphabetical).
		const srcCmp = a.normalized.source.localeCompare(b.normalized.source);
		if (srcCmp !== 0) return srcCmp;
		// Tertiary: original seq within the table.
		return a.originalSeq - b.originalSeq;
	});

	return all.map((item, i) => ({ seq: i + 1, ...item.normalized }));
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Merge all global `events` rows and `thread_events` rows for a run,
 * returning them in stable chronological order (see file-level ordering note).
 *
 * Returns an empty array when the run has no events — 404 is never raised
 * here; callers handle run existence separately.
 */
export function buildRunTranscript(handle: DbHandle, runId: number): TranscriptEvent[] {
	const globalRows = handle.db
		.select()
		.from(events)
		.where(eq(events.runId, runId))
		.orderBy(asc(events.seq))
		.all();

	const tRows = handle.db
		.select()
		.from(threadEvents)
		.where(eq(threadEvents.runId, runId))
		.orderBy(asc(threadEvents.seq))
		.all();

	const evNorm = globalRows.map((r) => ({ normalized: normalizeEventRow(r), originalSeq: r.seq }));
	const thNorm = tRows.map((r) => ({ normalized: normalizeThreadRow(r), originalSeq: r.seq }));

	return mergeAndSort(evNorm, thNorm);
}

export interface BuildTaskTranscriptOpts {
	/** When set, only return thread_events for this round. */
	round?: number;
	/**
	 * Pagination cursor: only include events whose merged `seq` is greater than
	 * this value. Applied AFTER merge + sort (so `seq` here is the transcript
	 * seq, not the table seq).
	 */
	afterSeq?: number;
	/** Maximum number of events to return after the `afterSeq` cursor. */
	limit?: number;
}

/**
 * Merge all global `events` rows and `thread_events` rows for a task,
 * with optional round filter and afterSeq/limit pagination.
 *
 * Ordering and tie-breaking are identical to `buildRunTranscript`.
 * Returns an empty array for tasks with no matching events — never 404.
 */
export function buildTaskTranscript(
	handle: DbHandle,
	taskId: number,
	opts: BuildTaskTranscriptOpts = {},
): TranscriptEvent[] {
	// Fetch global events for this task.
	const globalRows = handle.db
		.select()
		.from(events)
		.where(eq(events.taskId, taskId))
		.orderBy(asc(events.seq))
		.all();

	// Fetch thread events, optionally filtered by round.
	const threadWhere =
		opts.round !== undefined
			? and(eq(threadEvents.taskId, taskId), eq(threadEvents.round, opts.round))
			: eq(threadEvents.taskId, taskId);

	const tRows = handle.db
		.select()
		.from(threadEvents)
		.where(threadWhere)
		.orderBy(asc(threadEvents.seq))
		.all();

	const evNorm = globalRows.map((r) => ({ normalized: normalizeEventRow(r), originalSeq: r.seq }));
	const thNorm = tRows.map((r) => ({ normalized: normalizeThreadRow(r), originalSeq: r.seq }));

	let merged = mergeAndSort(evNorm, thNorm);

	// afterSeq pagination: seq is the merged 1-indexed value.
	if (opts.afterSeq !== undefined) {
		merged = merged.filter((e) => e.seq > opts.afterSeq!);
	}

	// limit: take only the first N after the cursor.
	if (opts.limit !== undefined) {
		merged = merged.slice(0, opts.limit);
	}

	return merged;
}
