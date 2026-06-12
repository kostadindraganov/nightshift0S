/**
 * WHY: HTTP routes for the project bootstrap endpoint (task 4.3). Follows the
 * same factory pattern as reviewRoutes.ts — a `makePlannerRoutes(cfg)` factory
 * so the production Planner (a real ProviderDriver) is injectable and the
 * route can be exercised with a fake in tests. routes.ts spreads the result in;
 * this file never touches routes.ts itself.
 */

import type { Route, RouteContext } from "./routes.ts";
import { json, jsonError } from "./routes.ts";
import { ValidationError } from "../tasks/tasks.ts";
import { getTask } from "../tasks/tasks.ts";
import { bootstrapProject, type Planner } from "../planner/bootstrap.ts";

// ---------------------------------------------------------------------------
// Config + factory
// ---------------------------------------------------------------------------

export interface PlannerRoutesConfig {
	/** Production wiring supplies a real ProviderDriver-backed Planner. */
	buildPlanner: (ctx: RouteContext) => Planner;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseProjectId(raw: string | undefined): number {
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		throw new ValidationError("project id must be a positive integer");
	}
	return n;
}

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makePlannerRoutes(cfg: PlannerRoutesConfig): Route[] {
	async function handleBootstrap(ctx: RouteContext): Promise<Response> {
		const projectId = parseProjectId(ctx.params.id);

		// Verify project exists (createTask will also check, but 404 here is cleaner).
		// We borrow getTask on a non-existent task to detect missing project via the
		// tasks table — but tasks.ts already throws 404 inside createTask for a bad
		// projectId, so we just proceed and let it surface as a 400/404 from createTask.
		// A lighter check: the route is scoped to /projects/:id so we can verify cheaply.
		const body = await readBody(ctx.req);
		if (typeof body.description !== "string" || body.description.trim().length === 0) {
			throw new ValidationError("description must be a non-empty string");
		}

		const planner = cfg.buildPlanner(ctx);
		const result = await bootstrapProject(
			{ handle: ctx.handle, planner },
			{ projectId, description: body.description },
		);

		if (!result.ok) {
			return jsonError(422, "bootstrap_failed", result.reason);
		}

		return json({ ok: true, tasks: result.tasks }, 201);
	}

	return [
		{
			method: "POST",
			path: "/projects/:id/bootstrap",
			auth: true,
			summary: "Bootstrap a project backlog from a freeform description via the planner",
			handler: handleBootstrap,
		},
	];
}
