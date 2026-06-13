/**
 * WHY: The experiment ledger is the append-only audit trail of the §3.11
 * hill-climbing loop (engine.ts). Each iteration writes ONE row recording what
 * the agent tried, the metric the eval produced, and whether the branch kept or
 * discarded the attempt. The ledger is the recovery surface and the data source
 * for the UI timeline + metric chart — the engine never holds iteration history
 * in memory, it reads it back from here.
 *
 * Single writer discipline: every append rides the serialized writer queue
 * (`enqueueWrite`) and emits its `experiment.iteration` audit event in the SAME
 * link (`emitInWriter`), so durability and publish order match. Reads are direct
 * (WAL snapshot isolation). NO secrets ever enter an event payload (§3.12.7) —
 * a ledger row is metric/commit/description data, never a credential.
 */

import { and, asc, eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import type { ExperimentStatus } from "../db/columns.ts";
import { experimentLedger, type ExperimentLedgerRow } from "../db/schema.ts";
import { enqueueWrite } from "../db/writer.ts";
import type { EventLog } from "../events/events.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AppendLedgerEntryInput {
	/** runs.id of the experiment routine run (FK experiment_ledger.routine_run_id). */
	routineRunId: number;
	iteration: number;
	/** Nullable: a `crash` iteration may never have committed. */
	commitSha?: string | null;
	metricName: string;
	metricValue?: number | null;
	status: ExperimentStatus;
	memoryNote?: string | null;
	description: string;
}

/** A point on the UI metric chart — one per ledger iteration, asc. */
export interface MetricPoint {
	iteration: number;
	metricValue: number | null;
	status: ExperimentStatus;
}

// ---------------------------------------------------------------------------
// appendLedgerEntry — the only writer of experiment_ledger
// ---------------------------------------------------------------------------

/**
 * Insert one ledger row and emit `experiment.iteration` in the SAME writer link.
 * `createdAt` is stamped here (new Date().toISOString()) so the row is the
 * canonical timestamp. Resolves with the persisted row.
 */
export async function appendLedgerEntry(
	handle: DbHandle,
	log: EventLog,
	input: AppendLedgerEntryInput,
): Promise<ExperimentLedgerRow> {
	return enqueueWrite(() => {
		const row = handle.db
			.insert(experimentLedger)
			.values({
				routineRunId: input.routineRunId,
				iteration: input.iteration,
				commitSha: input.commitSha ?? null,
				metricName: input.metricName,
				metricValue: input.metricValue ?? null,
				status: input.status,
				memoryNote: input.memoryNote ?? null,
				description: input.description,
				createdAt: new Date().toISOString(),
			})
			.returning()
			.get();
		log.emitInWriter({
			runId: row.routineRunId,
			kind: "experiment.iteration",
			payload: {
				routineRunId: row.routineRunId,
				iteration: row.iteration,
				status: row.status,
				metricName: row.metricName,
				metricValue: row.metricValue,
				commitSha: row.commitSha,
			},
		});
		return row;
	});
}

// ---------------------------------------------------------------------------
// Reads (direct — WAL snapshot isolation)
// ---------------------------------------------------------------------------

/** All ledger rows for a routine run, iteration ascending. */
export function listLedger(handle: DbHandle, routineRunId: number): ExperimentLedgerRow[] {
	return handle.db
		.select()
		.from(experimentLedger)
		.where(eq(experimentLedger.routineRunId, routineRunId))
		.orderBy(asc(experimentLedger.iteration))
		.all();
}

/** Iteration/metric/status triples for the UI chart, iteration ascending. */
export function metricSeries(handle: DbHandle, routineRunId: number): MetricPoint[] {
	return listLedger(handle, routineRunId).map((row) => ({
		iteration: row.iteration,
		metricValue: row.metricValue,
		status: row.status,
	}));
}

/**
 * The kept row with the best metric (lowest for direction "lower", highest for
 * "higher"), or null when no kept row carries a numeric metric. Only `keep`
 * rows are candidates — a discarded/crashed attempt never advanced the branch,
 * so it can never be "best".
 */
export function bestEntry(
	rows: ExperimentLedgerRow[],
	direction: "lower" | "higher",
): ExperimentLedgerRow | null {
	let best: ExperimentLedgerRow | null = null;
	for (const row of rows) {
		if (row.status !== "keep" || row.metricValue === null) continue;
		if (best === null) {
			best = row;
			continue;
		}
		const bestValue = best.metricValue as number;
		const better =
			direction === "lower" ? row.metricValue < bestValue : row.metricValue > bestValue;
		if (better) best = row;
	}
	return best;
}
