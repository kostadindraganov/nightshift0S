/**
 * HTTP routes for the run resource (task 2.5).
 *
 * Wired into the server by the coordinator (src/server/routes.ts spreads these
 * in). All routes require auth:true. The hook endpoint is the hot path —
 * Claude Code's hook.sh posts to it on every lifecycle event.
 */

import type { Route, RouteContext } from "../server/routes.ts";
import { json, jsonError } from "../server/routes.ts";
import type { RunState } from "../db/columns.ts";
import { RUN_STATES } from "../db/columns.ts";
import { ValidationError } from "../tasks/tasks.ts";
import { getRun, listRuns } from "./runs.ts";
import { transitionRun } from "./transitions.ts";
import { ingestHookEvent } from "./hookBridge.ts";

// ---------------------------------------------------------------------------
// Helpers

function parseRunId(raw: string | undefined): number {
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		throw new ValidationError("run id must be a positive integer");
	}
	return n;
}

/** Parse the request body as a plain JSON object; 400 if not. */
async function readBody(req: Request): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		throw new ValidationError("Request body must be valid JSON");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new ValidationError("Request body must be a JSON object");
	}
	return body as Record<string, unknown>;
}

function assertRunState(raw: unknown, field: string): RunState {
	if (!RUN_STATES.includes(raw as RunState)) {
		throw new ValidationError(`${field} must be a valid run state`);
	}
	return raw as RunState;
}

// ---------------------------------------------------------------------------
// Route handlers

async function handleListRuns(ctx: RouteContext): Promise<Response> {
	const rawTaskId = ctx.url.searchParams.get("task_id");
	const rawState = ctx.url.searchParams.get("state");
	const filter: { taskId?: number; state?: RunState } = {};
	if (rawTaskId !== null) {
		const n = Number(rawTaskId);
		if (!Number.isInteger(n)) throw new ValidationError("task_id must be an integer");
		filter.taskId = n;
	}
	if (rawState !== null) {
		filter.state = assertRunState(rawState, "state");
	}
	return json(listRuns(ctx.handle, filter));
}

async function handleGetRun(ctx: RouteContext): Promise<Response> {
	const id = parseRunId(ctx.params.id);
	const run = getRun(ctx.handle, id);
	if (!run) return jsonError(404, "not_found", `run ${id} not found`);
	return json(run);
}

async function handlePostEvents(ctx: RouteContext): Promise<Response> {
	const id = parseRunId(ctx.params.id);
	const run = getRun(ctx.handle, id);
	if (!run) return jsonError(404, "not_found", `run ${id} not found`);

	const body = await readBody(ctx.req);
	if (typeof body.kind !== "string" || body.kind.length === 0) {
		throw new ValidationError("kind must be a non-empty string");
	}

	const result = await ingestHookEvent(ctx.handle, ctx.events, id, {
		kind: body.kind,
		payload: body.payload ?? null,
	});
	return json({ ok: true, ...result });
}

async function handleStop(ctx: RouteContext): Promise<Response> {
	const id = parseRunId(ctx.params.id);
	const run = getRun(ctx.handle, id);
	if (!run) return jsonError(404, "not_found", `run ${id} not found`);

	const result = await transitionRun(ctx.handle, ctx.events, {
		runId: id,
		to: "killed",
		actor: "human",
	});

	if (!result.ok) {
		if (result.reason === "not_found") {
			return jsonError(404, "not_found", `run ${id} not found`);
		}
		if (result.reason === "illegal") {
			return jsonError(409, "illegal_transition", `run ${id} cannot be killed (already terminal?)`);
		}
		return jsonError(409, "lost_race", `run ${id} was moved by a concurrent actor`);
	}
	return json({ ok: true, run: result.run });
}

// ---------------------------------------------------------------------------
// Route table

export const runRoutes: Route[] = [
	{
		method: "GET",
		path: "/runs",
		auth: true,
		summary: "List runs, filterable by ?task_id= and ?state=",
		handler: handleListRuns,
	},
	{
		method: "GET",
		path: "/runs/:id",
		auth: true,
		summary: "Fetch one run by id",
		handler: handleGetRun,
	},
	{
		method: "POST",
		path: "/runs/:id/events",
		auth: true,
		summary: "Ingest a Claude Code lifecycle hook event for a run",
		handler: handlePostEvents,
	},
	{
		method: "POST",
		path: "/runs/:id/stop",
		auth: true,
		summary: "Manually stop (kill) a run",
		handler: handleStop,
	},
];
