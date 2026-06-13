/**
 * WHY: HTTP surface for per-project agent memory (BLUEPRINT §3 "Memory & knowledge").
 *
 * Three routes expose the full lifecycle of project-scoped memory entries:
 *
 *   GET    /projects/:id/memory        — list entries (?namespace= filter)
 *   PUT    /projects/:id/memory/:key   — upsert one entry {value, namespace?, source?}
 *   DELETE /projects/:id/memory/:key   — delete one entry (?namespace= filter)
 *
 * All routes are thin wrappers over the pure functions in memory.ts. No live
 * deps are injected here — they come from the RouteContext (handle, events).
 * Secret values are never stored or echoed (§3.12.7).
 */

import type { Route } from "../server/routes.ts";
import { json, jsonError } from "../server/routes.ts";
import { getMemory, listMemory, putMemory, deleteMemory } from "./memory.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a path :id param to an integer; returns null if not a valid integer. */
function parseId(raw: string): number | null {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

export const memoryRoutes: Route[] = [
	// -------------------------------------------------------------------------
	// GET /projects/:id/memory — list entries for a project
	// -------------------------------------------------------------------------
	{
		method: "GET",
		path: "/projects/:id/memory",
		auth: true,
		summary: "List agent memory entries for a project (?namespace= to filter by namespace)",
		handler: (ctx) => {
			const projectId = parseId(ctx.params.id ?? "");
			if (projectId === null) {
				return jsonError(400, "invalid_id", "project id must be a positive integer");
			}
			const namespace = ctx.url.searchParams.get("namespace") ?? undefined;
			const rows = listMemory(ctx.handle, projectId, namespace !== undefined ? { namespace } : undefined);
			return json(rows);
		},
	},

	// -------------------------------------------------------------------------
	// PUT /projects/:id/memory/:key — upsert one memory entry
	// -------------------------------------------------------------------------
	{
		method: "PUT",
		path: "/projects/:id/memory/:key",
		auth: true,
		summary: "Upsert a memory entry: {value, namespace?, source?}",
		handler: async (ctx) => {
			const projectId = parseId(ctx.params.id ?? "");
			if (projectId === null) {
				return jsonError(400, "invalid_id", "project id must be a positive integer");
			}
			const key = ctx.params.key ?? "";
			if (key.trim().length === 0) {
				return jsonError(400, "invalid", "key must be a non-empty string");
			}

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

			// "value" is required but can be any JSON type.
			if (!("value" in body)) {
				return jsonError(400, "invalid", "body must include a 'value' field");
			}

			const namespace =
				typeof body.namespace === "string" ? body.namespace : undefined;
			const source =
				typeof body.source === "string" && body.source.trim().length > 0
					? body.source
					: "api";

			const result = await putMemory(ctx.handle, ctx.events, {
				projectId,
				namespace,
				key,
				value: body.value,
				source,
			});

			if (!result.ok) {
				if (result.reason === "project_not_found") {
					return jsonError(404, "project_not_found", `project ${projectId} not found`);
				}
				return jsonError(400, "invalid", "invalid memory input");
			}

			return json(result.row, 200);
		},
	},

	// -------------------------------------------------------------------------
	// DELETE /projects/:id/memory/:key — delete one memory entry
	// -------------------------------------------------------------------------
	{
		method: "DELETE",
		path: "/projects/:id/memory/:key",
		auth: true,
		summary: "Delete a memory entry (?namespace= to target a specific namespace)",
		handler: async (ctx) => {
			const projectId = parseId(ctx.params.id ?? "");
			if (projectId === null) {
				return jsonError(400, "invalid_id", "project id must be a positive integer");
			}
			const key = ctx.params.key ?? "";
			if (key.trim().length === 0) {
				return jsonError(400, "invalid", "key must be a non-empty string");
			}
			const namespace = ctx.url.searchParams.get("namespace") ?? undefined;

			const result = await deleteMemory(ctx.handle, ctx.events, {
				projectId,
				namespace,
				key,
			});

			if (!result.ok) {
				return jsonError(404, "not_found", `memory entry '${key}' not found`);
			}

			return json({ ok: true });
		},
	},
];
