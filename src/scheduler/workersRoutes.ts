/**
 * WHY: HTTP surface for the V3 multi-VM worker registry (BLUEPRINT §workers).
 * Exposes register, list, and heartbeat over REST so remote daemons can phone
 * home to the single control plane without a shared database.
 *
 * Wired into src/server/routes.ts by spreading workersRoutes into the main
 * route table — this file never imports from routes.ts except the two helpers
 * (Route type + json/jsonError), matching the analyticsRoutes pattern.
 */

import type { Route } from "../server/routes.ts";
import { json, jsonError } from "../server/routes.ts";
import { loadConfig } from "../config/config.ts";
import { workerRegistry } from "./workers.ts";

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export const workersRoutes: Route[] = [
	{
		method: "GET",
		path: "/workers",
		auth: true,
		summary: "List all registered worker daemons with liveness computed from the current lease.",
		handler(_ctx) {
			const { leaseSeconds } = loadConfig().workers;
			return json(workerRegistry.list(Date.now(), leaseSeconds));
		},
	},

	{
		method: "POST",
		path: "/workers",
		auth: true,
		summary: "Register (or re-register) a worker daemon. Body: { id, host, capacity }.",
		async handler(ctx) {
			let body: unknown;
			try {
				body = await ctx.req.json();
			} catch {
				return jsonError(400, "invalid_json", "Request body must be valid JSON");
			}
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				return jsonError(400, "invalid_body", "Request body must be a JSON object");
			}
			const b = body as Record<string, unknown>;

			if (typeof b.id !== "string" || b.id.length === 0) {
				return jsonError(400, "invalid_field", "id must be a non-empty string");
			}
			if (typeof b.host !== "string" || b.host.length === 0) {
				return jsonError(400, "invalid_field", "host must be a non-empty string");
			}
			if (typeof b.capacity !== "number") {
				return jsonError(400, "invalid_field", "capacity must be a number");
			}

			const worker = workerRegistry.register(
				{ id: b.id, host: b.host, capacity: b.capacity },
				Date.now(),
			);
			return json(worker, 201);
		},
	},

	{
		method: "POST",
		path: "/workers/:id/heartbeat",
		auth: true,
		summary: "Record a heartbeat for a registered worker daemon. 404 if id is unknown.",
		handler(ctx) {
			const ok = workerRegistry.heartbeat(ctx.params.id ?? "", Date.now());
			if (!ok) {
				return jsonError(404, "not_found", `worker ${ctx.params.id} not found`);
			}
			return json({ ok: true });
		},
	},
];
