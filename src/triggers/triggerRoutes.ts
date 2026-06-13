/**
 * WHY: HTTP surface for routines + triggers (BLUEPRINT §3.2, §3.10 item 3,
 * §3.12.6). Thin wrappers over routines.ts and triggers.ts — validate the JSON
 * body, call the service, and map its fail-closed `reason` onto an HTTP status.
 * The orchestrator (src/server/routes.ts) spreads `triggerRoutes` into the
 * table; this module must not edit that file.
 *
 * REASON → STATUS map (shared by both resources):
 *   not_found                                    -> 404
 *   authz_denied                                 -> 403
 *   duplicate | rate_limited | dry_run_pending   -> 409
 *   anything else (invalid input)                -> 400
 *
 * All routes require auth:true. The manual-fire route is the only one that
 * dispatches; cron fires through the scheduler, not here. NO secrets cross the
 * wire — service results carry ids/reasons only (§3.12.7).
 */

import type { Route, RouteContext } from "../server/routes.ts";
import { json, jsonError } from "../server/routes.ts";
import type { RoutineKind, ReviewPolicy, TriggerKind } from "../db/columns.ts";
import {
	createRoutine,
	deleteRoutine,
	getRoutine,
	listRoutines,
	updateRoutine,
	type CreateRoutineInput,
	type UpdateRoutinePatch,
} from "./routines.ts";
import {
	createTrigger,
	deleteTrigger,
	fireTrigger,
	getTrigger,
	listTriggers,
	type CreateTriggerInput,
	type FireOpts,
	type TriggerSource,
	type UpdateTriggerPatch,
} from "./triggers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the body as a JSON object; 400 on anything else. Mirrors runRoutes. */
async function readBody(req: Request): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		throw new BodyError("Request body must be valid JSON");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new BodyError("Request body must be a JSON object");
	}
	return body as Record<string, unknown>;
}

/** Local 400-carrier so a malformed body short-circuits before the service call. */
class BodyError extends Error {}

function parseId(raw: string | undefined): number | null {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Map a service `reason` to an HTTP error response. Anything not in the
 * not_found / authz / conflict sets is treated as invalid input (400).
 */
function reasonError(reason: string): Response {
	if (reason === "not_found") return jsonError(404, "not_found", reason);
	if (reason === "authz_denied") return jsonError(403, "authz_denied", reason);
	if (reason === "duplicate" || reason === "rate_limited" || reason === "dry_run_pending") {
		return jsonError(409, reason, reason);
	}
	return jsonError(400, "invalid_input", reason);
}

/** Read an optional string field, or null/undefined when absent — no type coercion. */
function optStr(body: Record<string, unknown>, key: string): string | null | undefined {
	const v = body[key];
	if (v === undefined) return undefined;
	if (v === null) return null;
	return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Routine handlers
// ---------------------------------------------------------------------------

async function handleCreateRoutine(ctx: RouteContext): Promise<Response> {
	const body = await readBody(ctx.req);
	const input: CreateRoutineInput = {
		projectId: typeof body.project_id === "number" ? body.project_id : null,
		name: body.name as string,
		kind: body.kind as RoutineKind,
		promptName: body.prompt_name as string,
		paramsJson: optStr(body, "params_json") ?? null,
		providerPref: optStr(body, "provider_pref") ?? null,
		rubric: optStr(body, "rubric") ?? null,
		budgetJson: optStr(body, "budget_json") ?? null,
		...(body.review_policy !== undefined
			? { reviewPolicy: body.review_policy as ReviewPolicy }
			: {}),
		...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
	};
	const result = await createRoutine(ctx.handle, ctx.events, input);
	if (!result.ok) return reasonError(result.reason);
	return json(result.routine, 201);
}

function handleListRoutines(ctx: RouteContext): Response {
	const rawProject = ctx.url.searchParams.get("project_id");
	const filter: { projectId?: number; kind?: RoutineKind } = {};
	if (rawProject !== null) {
		const n = Number(rawProject);
		if (Number.isInteger(n)) filter.projectId = n;
	}
	const rawKind = ctx.url.searchParams.get("kind");
	if (rawKind !== null) filter.kind = rawKind as RoutineKind;
	return json(listRoutines(ctx.handle, filter));
}

function handleGetRoutine(ctx: RouteContext): Response {
	const id = parseId(ctx.params.id);
	if (id === null) return jsonError(400, "invalid_input", "routine id must be a positive integer");
	const routine = getRoutine(ctx.handle, id);
	if (routine === null) return jsonError(404, "not_found", `routine ${id} not found`);
	return json(routine);
}

async function handleUpdateRoutine(ctx: RouteContext): Promise<Response> {
	const id = parseId(ctx.params.id);
	if (id === null) return jsonError(400, "invalid_input", "routine id must be a positive integer");
	const body = await readBody(ctx.req);
	const patch: UpdateRoutinePatch = {};
	if (typeof body.name === "string") patch.name = body.name;
	if (typeof body.prompt_name === "string") patch.promptName = body.prompt_name;
	if (body.kind !== undefined) patch.kind = body.kind as RoutineKind;
	if (body.review_policy !== undefined) patch.reviewPolicy = body.review_policy as ReviewPolicy;
	if ("params_json" in body) patch.paramsJson = optStr(body, "params_json") ?? null;
	if ("budget_json" in body) patch.budgetJson = optStr(body, "budget_json") ?? null;
	if ("provider_pref" in body) patch.providerPref = optStr(body, "provider_pref") ?? null;
	if ("rubric" in body) patch.rubric = optStr(body, "rubric") ?? null;
	if ("project_id" in body) {
		patch.projectId = typeof body.project_id === "number" ? body.project_id : null;
	}
	if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
	const result = await updateRoutine(ctx.handle, ctx.events, id, patch);
	if (!result.ok) return reasonError(result.reason);
	return json(result.routine);
}

async function handleDeleteRoutine(ctx: RouteContext): Promise<Response> {
	const id = parseId(ctx.params.id);
	if (id === null) return jsonError(400, "invalid_input", "routine id must be a positive integer");
	const result = await deleteRoutine(ctx.handle, ctx.events, id);
	if (!result.ok) return reasonError(result.reason);
	return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Trigger handlers
// ---------------------------------------------------------------------------

async function handleCreateTrigger(ctx: RouteContext): Promise<Response> {
	const body = await readBody(ctx.req);
	if (typeof body.routine_id !== "number") {
		return jsonError(400, "invalid_input", "routine_id must be an integer");
	}
	const input: CreateTriggerInput = {
		routineId: body.routine_id,
		kind: body.kind as TriggerKind,
		schedule: optStr(body, "schedule") ?? null,
		authzJson: optStr(body, "authz_json") ?? null,
		...(typeof body.dry_run_default === "boolean" ? { dryRunDefault: body.dry_run_default } : {}),
		...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
	};
	const result = await createTrigger({ handle: ctx.handle, log: ctx.events }, input);
	if (!result.ok) return reasonError(result.reason);
	return json(result.trigger, 201);
}

function handleListTriggers(ctx: RouteContext): Response {
	const rawRoutine = ctx.url.searchParams.get("routine_id");
	const filter: { routineId?: number; kind?: TriggerKind } = {};
	if (rawRoutine !== null) {
		const n = Number(rawRoutine);
		if (Number.isInteger(n)) filter.routineId = n;
	}
	const rawKind = ctx.url.searchParams.get("kind");
	if (rawKind !== null) filter.kind = rawKind as TriggerKind;
	return json(listTriggers(ctx.handle, filter));
}

function handleGetTrigger(ctx: RouteContext): Response {
	const id = parseId(ctx.params.id);
	if (id === null) return jsonError(400, "invalid_input", "trigger id must be a positive integer");
	const trigger = getTrigger(ctx.handle, id);
	if (trigger === null) return jsonError(404, "not_found", `trigger ${id} not found`);
	return json(trigger);
}

async function handleDeleteTrigger(ctx: RouteContext): Promise<Response> {
	const id = parseId(ctx.params.id);
	if (id === null) return jsonError(400, "invalid_input", "trigger id must be a positive integer");
	const result = await deleteTrigger({ handle: ctx.handle, log: ctx.events }, id);
	if (!result.ok) return reasonError(result.reason);
	return json({ ok: true });
}

async function handleFireTrigger(ctx: RouteContext): Promise<Response> {
	const id = parseId(ctx.params.id);
	if (id === null) return jsonError(400, "invalid_input", "trigger id must be a positive integer");
	const body = await readBody(ctx.req);
	const actor =
		typeof body.actor === "string" && body.actor.length > 0 ? body.actor : "api";
	const opts: FireOpts = {
		actor,
		source: "manual" as TriggerSource,
		...(typeof body.dedupe_key === "string" ? { dedupeKey: body.dedupe_key } : {}),
	};
	const result = await fireTrigger({ handle: ctx.handle, log: ctx.events }, id, opts);
	if (!result.ok) return reasonError(result.reason);
	return json({ ok: true, task_id: result.taskId }, 201);
}

// ---------------------------------------------------------------------------
// Route table — wraps BodyError into a 400 so a bad body never 500s.
// ---------------------------------------------------------------------------

/** Wrap a handler so a thrown BodyError surfaces as 400 (other throws propagate). */
function guard(
	handler: (ctx: RouteContext) => Response | Promise<Response>,
): (ctx: RouteContext) => Promise<Response> {
	return async (ctx) => {
		try {
			return await handler(ctx);
		} catch (err) {
			if (err instanceof BodyError) return jsonError(400, "invalid_input", err.message);
			throw err;
		}
	};
}

export const triggerRoutes: Route[] = [
	{
		method: "POST",
		path: "/routines",
		auth: true,
		summary: "Create a routine (name, kind, prompt_name, review_policy, budgets)",
		handler: guard(handleCreateRoutine),
	},
	{
		method: "GET",
		path: "/routines",
		auth: true,
		summary: "List routines, filterable by ?project_id= and ?kind=",
		handler: guard(handleListRoutines),
	},
	{
		method: "GET",
		path: "/routines/:id",
		auth: true,
		summary: "Fetch one routine by id",
		handler: guard(handleGetRoutine),
	},
	{
		method: "PATCH",
		path: "/routines/:id",
		auth: true,
		summary: "Update routine fields (name, kind, review_policy, budgets, enabled)",
		handler: guard(handleUpdateRoutine),
	},
	{
		method: "DELETE",
		path: "/routines/:id",
		auth: true,
		summary: "Delete a routine",
		handler: guard(handleDeleteRoutine),
	},
	{
		method: "POST",
		path: "/triggers",
		auth: true,
		summary: "Create a trigger pointing at a routine (manual/cron/webhook/chat)",
		handler: guard(handleCreateTrigger),
	},
	{
		method: "GET",
		path: "/triggers",
		auth: true,
		summary: "List triggers, filterable by ?routine_id= and ?kind=",
		handler: guard(handleListTriggers),
	},
	{
		method: "GET",
		path: "/triggers/:id",
		auth: true,
		summary: "Fetch one trigger by id",
		handler: guard(handleGetTrigger),
	},
	{
		method: "DELETE",
		path: "/triggers/:id",
		auth: true,
		summary: "Delete a trigger",
		handler: guard(handleDeleteTrigger),
	},
	{
		method: "POST",
		path: "/triggers/:id/fire",
		auth: true,
		summary: "Manually fire a trigger now: {actor?, dedupe_key?} → creates a backlog task",
		handler: guard(handleFireTrigger),
	},
];
