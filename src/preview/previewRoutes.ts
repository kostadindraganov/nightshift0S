/**
 * WHY: HTTP surface for V3 preview environments (BLUEPRINT §V3). Four routes:
 *
 *   GET    /previews              — list all envs
 *   POST   /previews              — create env for {run_id}
 *   POST   /previews/:runId/touch — touch (reset idle timer)
 *   DELETE /previews/:runId       — reap (teardown + mark reaped)
 *
 * A module-singleton PreviewManager is built lazily from loadConfig().preview
 * + FailClosedDeployer. On unwired hosts the deployer throws, create() records
 * status "failed", and the route returns 201 with the honest failed env — the
 * caller can see the state rather than getting an unhandled 500.
 *
 * When preview.domain is empty the allocateUrl throw is caught and returned as
 * 409 preview_disabled so clients get a clear signal rather than a 500.
 */

import type { Route } from "../server/routes.ts";
import { json, jsonError } from "../server/routes.ts";
import { loadConfig } from "../config/config.ts";
import { makePreviewManager, FailClosedDeployer, type PreviewManager } from "./preview.ts";

// ---------------------------------------------------------------------------
// Lazy module-singleton
// ---------------------------------------------------------------------------

let _manager: PreviewManager | undefined;

function getManager(): PreviewManager {
	if (_manager === undefined) {
		const cfg = loadConfig().preview;
		_manager = makePreviewManager({
			deployer: new FailClosedDeployer(),
			domain: cfg.domain,
		});
	}
	return _manager;
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

export const previewRoutes: Route[] = [
	// -------------------------------------------------------------------------
	// GET /previews — list all preview envs
	// -------------------------------------------------------------------------
	{
		method: "GET",
		path: "/previews",
		auth: true,
		summary: "List all preview environments.",
		handler(_ctx) {
			return json(getManager().list());
		},
	},

	// -------------------------------------------------------------------------
	// POST /previews — create a preview env for a run
	// -------------------------------------------------------------------------
	{
		method: "POST",
		path: "/previews",
		auth: true,
		summary: "Create a preview environment for {run_id}. Returns 409 when preview is disabled (no domain).",
		async handler(ctx) {
			let body: Record<string, unknown>;
			try {
				const raw = await ctx.req.json();
				if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
					return jsonError(400, "invalid", "request body must be a JSON object");
				}
				body = raw as Record<string, unknown>;
			} catch {
				return jsonError(400, "invalid", "request body must be valid JSON");
			}

			const runId = body.run_id;
			if (typeof runId !== "number" || !Number.isInteger(runId)) {
				return jsonError(400, "invalid", "run_id must be an integer");
			}

			try {
				const env = await getManager().create(runId, Date.now());
				return json(env, 201);
			} catch (err) {
				// allocateUrl throws when domain is empty (fail-closed).
				return jsonError(409, "preview_disabled", String((err as Error).message));
			}
		},
	},

	// -------------------------------------------------------------------------
	// POST /previews/:runId/touch — reset idle timer
	// -------------------------------------------------------------------------
	{
		method: "POST",
		path: "/previews/:runId/touch",
		auth: true,
		summary: "Touch a preview environment to reset its idle timer.",
		handler(ctx) {
			const runId = Number(ctx.params.runId);
			if (!Number.isInteger(runId)) {
				return jsonError(400, "invalid", "runId must be an integer");
			}
			const ok = getManager().touch(runId, Date.now());
			if (!ok) {
				return jsonError(404, "not_found", `preview for run ${runId} not found`);
			}
			return json({ ok: true });
		},
	},

	// -------------------------------------------------------------------------
	// DELETE /previews/:runId — reap a preview env
	// -------------------------------------------------------------------------
	{
		method: "DELETE",
		path: "/previews/:runId",
		auth: true,
		summary: "Reap (teardown + mark reaped) a preview environment.",
		async handler(ctx) {
			const runId = Number(ctx.params.runId);
			if (!Number.isInteger(runId)) {
				return jsonError(400, "invalid", "runId must be an integer");
			}
			const ok = await getManager().reap(runId, Date.now());
			if (!ok) {
				return jsonError(404, "not_found", `preview for run ${runId} not found`);
			}
			return json({ ok: true });
		},
	},
];
