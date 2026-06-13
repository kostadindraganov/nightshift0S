/**
 * WHY: Routines are the reusable "what to run" records (BLUEPRINT §3.2,
 * §3.10 item 3). A routine names a prompt + provider preference + budget +
 * review policy; triggers (manual/cron/webhook/chat — see triggers.ts) point at
 * a routine and turn it into concrete tasks. This module is plain CRUD over the
 * `routines` table: validate input, write through the serialized writer queue,
 * and emit an audit event on every mutation.
 *
 * FAIL-CLOSED: invalid kind / review_policy / missing name|promptName, or
 * unparseable params_json|budget_json, return { ok:false, reason } rather than
 * persisting a half-valid row. A not_found target on update/delete is the same
 * shape. Reads are direct (WAL snapshot isolation); writes ride enqueueWrite.
 * NO secrets ever enter an event payload (§3.12.7) — routine fields are config,
 * not credentials, and we emit only ids/names/policy, never raw JSON blobs.
 */

import { and, eq, type SQL } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import {
	REVIEW_POLICIES,
	ROUTINE_KINDS,
	type ReviewPolicy,
	type RoutineKind,
} from "../db/columns.ts";
import { routines, type RoutineRow } from "../db/schema.ts";
import { enqueueWrite } from "../db/writer.ts";
import type { EventLog } from "../events/events.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CreateRoutineInput {
	/** Nullable — a routine can be global (no project). */
	projectId?: number | null;
	name: string;
	kind: RoutineKind;
	promptName: string;
	/** Free-form JSON string; validated as parseable when present. */
	paramsJson?: string | null;
	providerPref?: string | null;
	rubric?: string | null;
	/** Free-form JSON string; validated as parseable when present. */
	budgetJson?: string | null;
	reviewPolicy?: ReviewPolicy;
	enabled?: boolean;
}

export interface UpdateRoutinePatch {
	projectId?: number | null;
	name?: string;
	kind?: RoutineKind;
	promptName?: string;
	paramsJson?: string | null;
	providerPref?: string | null;
	rubric?: string | null;
	budgetJson?: string | null;
	reviewPolicy?: ReviewPolicy;
	enabled?: boolean;
}

export interface ListRoutinesFilter {
	projectId?: number | null;
	kind?: RoutineKind;
	enabled?: boolean;
}

export type RoutineResult =
	| { ok: true; routine: RoutineRow }
	| { ok: false; reason: string };

export type DeleteRoutineResult = { ok: true } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Validation helpers (mirror tasks.ts: accept value, return reason on failure)
// ---------------------------------------------------------------------------

/** A non-empty trimmed string, or a reason. */
function requireString(value: unknown, field: string): { ok: true; value: string } | { ok: false; reason: string } {
	if (typeof value !== "string" || value.trim().length === 0) {
		return { ok: false, reason: `${field} is required` };
	}
	return { ok: true, value: value.trim() };
}

/** JSON-string is parseable (or null/undefined). Returns a reason on a bad blob. */
function validateJson(value: unknown, field: string): { ok: true } | { ok: false; reason: string } {
	if (value === null || value === undefined) return { ok: true };
	if (typeof value !== "string") return { ok: false, reason: `${field} must be a JSON string` };
	try {
		JSON.parse(value);
		return { ok: true };
	} catch {
		return { ok: false, reason: `${field} must be valid JSON` };
	}
}

function validateKind(value: RoutineKind): boolean {
	return (ROUTINE_KINDS as readonly string[]).includes(value);
}

function validateReviewPolicy(value: ReviewPolicy): boolean {
	return (REVIEW_POLICIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Reads (direct — WAL snapshot isolation)
// ---------------------------------------------------------------------------

export function getRoutine(handle: DbHandle, id: number): RoutineRow | null {
	return handle.db.select().from(routines).where(eq(routines.id, id)).get() ?? null;
}

export function listRoutines(handle: DbHandle, filter: ListRoutinesFilter = {}): RoutineRow[] {
	const clauses: SQL[] = [];
	if (filter.projectId !== undefined && filter.projectId !== null) {
		clauses.push(eq(routines.projectId, filter.projectId));
	}
	if (filter.kind !== undefined) clauses.push(eq(routines.kind, filter.kind));
	if (filter.enabled !== undefined) clauses.push(eq(routines.enabled, filter.enabled));
	const query = handle.db.select().from(routines);
	const rows = (clauses.length > 0 ? query.where(and(...clauses)) : query).all();
	return rows.sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------
// createRoutine
// ---------------------------------------------------------------------------

export async function createRoutine(
	handle: DbHandle,
	log: EventLog,
	input: CreateRoutineInput,
): Promise<RoutineResult> {
	const name = requireString(input.name, "name");
	if (!name.ok) return name;
	const promptName = requireString(input.promptName, "promptName");
	if (!promptName.ok) return promptName;
	if (!validateKind(input.kind)) {
		return { ok: false, reason: `invalid kind '${String(input.kind)}'` };
	}
	const reviewPolicy = input.reviewPolicy ?? "full";
	if (!validateReviewPolicy(reviewPolicy)) {
		return { ok: false, reason: `invalid reviewPolicy '${String(reviewPolicy)}'` };
	}
	const params = validateJson(input.paramsJson, "params_json");
	if (!params.ok) return params;
	const budget = validateJson(input.budgetJson, "budget_json");
	if (!budget.ok) return budget;

	const routine = await enqueueWrite(() => {
		const row = handle.db
			.insert(routines)
			.values({
				projectId: input.projectId ?? null,
				name: name.value,
				kind: input.kind,
				promptName: promptName.value,
				paramsJson: input.paramsJson ?? null,
				providerPref: input.providerPref ?? null,
				rubric: input.rubric ?? null,
				budgetJson: input.budgetJson ?? null,
				reviewPolicy,
				...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
			})
			.returning()
			.get();
		log.emitInWriter({
			kind: "routine.created",
			payload: {
				routineId: row.id,
				name: row.name,
				kind: row.kind,
				reviewPolicy: row.reviewPolicy,
				projectId: row.projectId,
			},
			...(row.projectId !== null ? { projectId: row.projectId } : {}),
		});
		return row;
	});
	return { ok: true, routine };
}

// ---------------------------------------------------------------------------
// updateRoutine
// ---------------------------------------------------------------------------

export async function updateRoutine(
	handle: DbHandle,
	log: EventLog,
	id: number,
	patch: UpdateRoutinePatch,
): Promise<RoutineResult> {
	// Validate every provided field BEFORE entering the writer queue.
	const set: Partial<typeof routines.$inferInsert> = {};
	if (patch.name !== undefined) {
		const name = requireString(patch.name, "name");
		if (!name.ok) return name;
		set.name = name.value;
	}
	if (patch.promptName !== undefined) {
		const promptName = requireString(patch.promptName, "promptName");
		if (!promptName.ok) return promptName;
		set.promptName = promptName.value;
	}
	if (patch.kind !== undefined) {
		if (!validateKind(patch.kind)) return { ok: false, reason: `invalid kind '${String(patch.kind)}'` };
		set.kind = patch.kind;
	}
	if (patch.reviewPolicy !== undefined) {
		if (!validateReviewPolicy(patch.reviewPolicy)) {
			return { ok: false, reason: `invalid reviewPolicy '${String(patch.reviewPolicy)}'` };
		}
		set.reviewPolicy = patch.reviewPolicy;
	}
	if (patch.paramsJson !== undefined) {
		const params = validateJson(patch.paramsJson, "params_json");
		if (!params.ok) return params;
		set.paramsJson = patch.paramsJson;
	}
	if (patch.budgetJson !== undefined) {
		const budget = validateJson(patch.budgetJson, "budget_json");
		if (!budget.ok) return budget;
		set.budgetJson = patch.budgetJson;
	}
	if (patch.projectId !== undefined) set.projectId = patch.projectId;
	if (patch.providerPref !== undefined) set.providerPref = patch.providerPref;
	if (patch.rubric !== undefined) set.rubric = patch.rubric;
	if (patch.enabled !== undefined) set.enabled = patch.enabled;

	const result = await enqueueWrite<RoutineResult>(() => {
		const existing = getRoutine(handle, id);
		if (existing === null) return { ok: false, reason: "not_found" };
		const row =
			Object.keys(set).length === 0
				? existing
				: handle.db.update(routines).set(set).where(eq(routines.id, id)).returning().get();
		log.emitInWriter({
			kind: "routine.updated",
			payload: {
				routineId: row.id,
				name: row.name,
				kind: row.kind,
				reviewPolicy: row.reviewPolicy,
				enabled: row.enabled,
			},
			...(row.projectId !== null ? { projectId: row.projectId } : {}),
		});
		return { ok: true, routine: row };
	});
	return result;
}

// ---------------------------------------------------------------------------
// deleteRoutine
// ---------------------------------------------------------------------------

export async function deleteRoutine(
	handle: DbHandle,
	log: EventLog,
	id: number,
): Promise<DeleteRoutineResult> {
	return enqueueWrite<DeleteRoutineResult>(() => {
		const existing = getRoutine(handle, id);
		if (existing === null) return { ok: false, reason: "not_found" };
		handle.db.delete(routines).where(eq(routines.id, id)).run();
		log.emitInWriter({
			kind: "routine.deleted",
			payload: { routineId: id, name: existing.name },
			...(existing.projectId !== null ? { projectId: existing.projectId } : {}),
		});
		return { ok: true };
	});
}
