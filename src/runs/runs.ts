/**
 * Run CRUD + task-claim coupling (task 2.5).
 *
 * All writes go through `enqueueWrite` (one serialized SQLite writer).
 * The schema-level partial unique index `one_active_run_per_task` (WHERE
 * state NOT IN terminal set) enforces at most one active run per task at the
 * DB level — surfaced here as `RunConflictError` (HTTP 409).
 *
 * `claimTaskAndCreateRun` is the atomic ready→coding coupling: the task
 * transition and the run creation happen in a coherent flow so there is never
 * an orphan run if the claim loses the race.
 */

import { and, eq, type SQL } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { type AuthLane, type RunKind, type RunState } from "../db/columns.ts";
import { runs, type RunRow } from "../db/schema.ts";
import { enqueueWrite } from "../db/writer.ts";
import type { EventLog } from "../events/events.ts";
import { transitionTask } from "../tasks/transitions.ts";
import { transitionRun } from "./transitions.ts";

/**
 * Thrown when attempting to create an active run for a task that already has
 * one (partial-unique index `one_active_run_per_task` violated). HTTP 409.
 */
export class RunConflictError extends Error {
	readonly status = 409;
	constructor(taskId: number) {
		super(`Task ${taskId} already has an active run`);
		this.name = "RunConflictError";
	}
}

// ---------------------------------------------------------------------------
// CRUD

export interface CreateRunInput {
	readonly taskId: number;
	readonly kind: RunKind;
	readonly provider: string;
	readonly model: string;
	readonly authLane: AuthLane;
}

/**
 * Insert a run in state=queued. Relies on the partial-unique index to reject a
 * second active run for the same task, surfacing the UNIQUE constraint as
 * `RunConflictError`.
 */
export function createRun(handle: DbHandle, input: CreateRunInput): Promise<RunRow> {
	const { taskId, kind, provider, model, authLane } = input;
	return enqueueWrite((): RunRow => {
		try {
			return handle.db
				.insert(runs)
				.values({ taskId, kind, provider, model, authLane, state: "queued" })
				.returning()
				.get();
		} catch (err) {
			// Drizzle/bun:sqlite surfaces UNIQUE violations as plain Errors with a
			// message matching /UNIQUE|constraint/i.
			if (
				err instanceof Error &&
				/UNIQUE|constraint/i.test(err.message)
			) {
				throw new RunConflictError(taskId);
			}
			throw err;
		}
	});
}

export function getRun(handle: DbHandle, id: number): RunRow | null {
	return handle.db.select().from(runs).where(eq(runs.id, id)).get() ?? null;
}

export interface ListRunsFilter {
	readonly taskId?: number;
	readonly state?: RunState;
}

export function listRuns(handle: DbHandle, filter: ListRunsFilter = {}): RunRow[] {
	const clauses: SQL[] = [];
	if (filter.taskId !== undefined) clauses.push(eq(runs.taskId, filter.taskId));
	if (filter.state !== undefined) clauses.push(eq(runs.state, filter.state));
	const query = handle.db.select().from(runs);
	return (clauses.length > 0 ? query.where(and(...clauses)) : query).all();
}

// ---------------------------------------------------------------------------
// Atomic task claim + run creation

export type ClaimResult =
	| { ok: true; run: RunRow }
	| { ok: false; reason: string };

/**
 * Atomically claim a ready task (ready→coding) and create a run for it.
 *
 * Flow:
 *   1. Create the run (state=queued) so we have a run.id for claimedBy.
 *   2. Transition the task ready→coding with claimedBy=run.id.
 *   3. If the task claim loses the race (task already claimed by another),
 *      the run is immediately killed so no orphan run is left behind.
 *
 * Returns {ok:false} if the task is not in ready state or the claim loses the
 * race. RunConflictError from step 1 propagates (the task already has a live
 * run — the caller should investigate).
 */
export async function claimTaskAndCreateRun(
	handle: DbHandle,
	log: EventLog,
	input: CreateRunInput & { baseSha?: string },
): Promise<ClaimResult> {
	// Step 1: create the run first so we have a run.id.
	const run = await createRun(handle, input);

	// Step 2: attempt to transition the task ready→coding.
	const claimResult = await transitionTask(handle, log, {
		taskId: input.taskId,
		to: "coding",
		expectedFrom: "ready",
		actor: `run:${run.id}`,
		extra: {
			claimedBy: run.id,
			...(input.baseSha ? { baseSha: input.baseSha } : {}),
		},
	});

	if (!claimResult.ok) {
		// Step 3: the claim failed — kill the orphan run immediately.
		await transitionRun(handle, log, {
			runId: run.id,
			to: "killed",
			expectedFrom: "queued",
			actor: "claim_rollback",
		});
		return { ok: false, reason: claimResult.reason };
	}

	return { ok: true, run };
}

// ---------------------------------------------------------------------------
// finishRun convenience

export interface FinishRunInput {
	readonly runId: number;
	readonly outcome: "succeeded" | "failed";
	readonly exitReason?: string;
	readonly cost?: {
		readonly tokensIn?: number;
		readonly tokensOut?: number;
		readonly costUsd?: number;
		readonly priced?: boolean;
	};
}

/**
 * Convenience wrapper over `transitionRun` for the finishing→terminal step.
 * The run must already be in `finishing` state (use `transitionRun` directly
 * for finer-grained control from other states).
 */
export function finishRun(
	handle: DbHandle,
	log: EventLog,
	input: FinishRunInput,
): Promise<import("./transitions.ts").RunTransitionResult> {
	return transitionRun(handle, log, {
		runId: input.runId,
		to: input.outcome,
		expectedFrom: "finishing",
		actor: "finish_run",
		extra: {
			exitReason: input.exitReason,
			tokensIn: input.cost?.tokensIn,
			tokensOut: input.cost?.tokensOut,
			costUsd: input.cost?.costUsd,
			priced: input.cost?.priced,
		},
	});
}
