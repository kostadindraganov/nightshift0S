/**
 * WHY: HTTP surface for the editable settings registry (BLUEPRINT §3.12.19).
 *
 * Five routes expose the full CRUD lifecycle for scoped runtime overrides:
 *
 *   GET  /settings/registry  — static: what keys are editable and with what
 *                              types, scopes, and defaults.
 *   GET  /settings           — dynamic: effective config (base + DB layers)
 *                              plus the raw override rows, all secret-masked.
 *   PUT  /settings/:scope/:key — upsert one setting; 400 on validation failures.
 *   DELETE /settings/:scope/:key — revert one setting to default; 404 if absent.
 *   GET  /settings/audit     — newest-first audit events for settings changes.
 *
 * All secret values are masked before they reach HTTP responses (BLUEPRINT §3.12.7).
 * The routes inject no live deps of their own — they call the pure functions in
 * registry.ts, which carry all the logic.
 */

import type { Route } from "../server/routes.ts";
import { json, jsonError } from "../server/routes.ts";
import type { SettingScope } from "../db/columns.ts";
import { SETTING_SCOPES } from "../db/columns.ts";
import { loadConfigWithSources } from "./config.ts";
import {
	REGISTRY,
	getSetting,
	listSettings,
	putSetting,
	deleteSetting,
	resolveEffectiveConfig,
	listAuditEvents,
} from "./registry.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Assert that a route param is a valid SettingScope; throws a 400 response string otherwise. */
function parseScope(raw: string): SettingScope | null {
	if ((SETTING_SCOPES as readonly string[]).includes(raw)) return raw as SettingScope;
	return null;
}

/** Parse ?limit= query param with a fallback. */
function parseLimit(raw: string | null, fallback: number): number {
	if (raw === null) return fallback;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

export const settingsRegistryRoutes: Route[] = [
	// -------------------------------------------------------------------------
	// GET /settings/registry — static key definitions
	// -------------------------------------------------------------------------
	{
		method: "GET",
		path: "/settings/registry",
		auth: true,
		summary: "List all editable settings key definitions (key, configPath, type, scopes, secret, default)",
		handler: () => {
			const entries = Object.values(REGISTRY).map((def) => ({
				key: def.key,
				configPath: def.configPath,
				type: def.type,
				scopes: def.scopes,
				secret: def.secret,
				default: def.secret ? "********" : def.defaultValue,
			}));
			return json(entries);
		},
	},

	// -------------------------------------------------------------------------
	// GET /settings — effective config + override rows
	// -------------------------------------------------------------------------
	{
		method: "GET",
		path: "/settings",
		auth: true,
		summary: "Effective config (base + DB layers) with provenance, plus current override rows. ?project_id= &routine_id=",
		handler: (ctx) => {
			const rawProject = ctx.url.searchParams.get("project_id");
			const rawRoutine = ctx.url.searchParams.get("routine_id");
			const projectId = rawProject !== null ? Number(rawProject) : null;
			const routineId = rawRoutine !== null ? Number(rawRoutine) : null;

			// Validate numeric params.
			if (rawProject !== null && !Number.isInteger(projectId)) {
				return jsonError(400, "invalid_param", "project_id must be an integer");
			}
			if (rawRoutine !== null && !Number.isInteger(routineId)) {
				return jsonError(400, "invalid_param", "routine_id must be an integer");
			}

			const { config: base, sources: baseProvenance } = loadConfigWithSources();
			const { config, provenance } = resolveEffectiveConfig(ctx.handle, base, {
				projectId,
				routineId,
				baseProvenance,
			});

			// Flatten the effective config into {path, value, source} entries,
			// masking secrets.
			const secretPaths = new Set(
				Object.values(REGISTRY)
					.filter((d) => d.secret)
					.map((d) => d.configPath),
			);

			const entries: Array<{ path: string; value: unknown; source: string }> = [];
			for (const [section, sectionVal] of Object.entries(config)) {
				if (sectionVal === null || typeof sectionVal !== "object" || Array.isArray(sectionVal)) continue;
				for (const [leaf, rawValue] of Object.entries(sectionVal as Record<string, unknown>)) {
					const path = `${section}.${leaf}`;
					const isSecret = secretPaths.has(path);
					entries.push({
						path,
						value: isSecret ? "********" : rawValue,
						source: provenance[path] ?? "default",
					});
				}
			}

			// Raw override rows (secret-masked by listSettings).
			const overrides = listSettings(ctx.handle, undefined);

			return json({ entries, overrides });
		},
	},

	// -------------------------------------------------------------------------
	// PUT /settings/:scope/:key — upsert a setting
	// -------------------------------------------------------------------------
	{
		method: "PUT",
		path: "/settings/:scope/:key",
		auth: true,
		summary: "Upsert a settings override. Body: {value, scope_id?, updated_by?}",
		handler: async (ctx) => {
			const scope = parseScope(ctx.params.scope ?? "");
			if (scope === null) {
				return jsonError(
					400,
					"invalid_scope",
					`scope must be one of: ${SETTING_SCOPES.join(", ")}`,
				);
			}

			const key = ctx.params.key ?? "";
			if (!key) {
				return jsonError(400, "invalid_param", "key is required");
			}

			let body: Record<string, unknown>;
			try {
				body = (await ctx.req.json()) as Record<string, unknown>;
			} catch {
				return jsonError(400, "invalid_json", "request body must be valid JSON");
			}
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				return jsonError(400, "invalid_body", "request body must be a JSON object");
			}

			if (!("value" in body)) {
				return jsonError(400, "missing_field", "body must contain a 'value' field");
			}

			const rawScopeId = body["scope_id"];
			const scopeId =
				rawScopeId === undefined || rawScopeId === null
					? null
					: typeof rawScopeId === "number"
						? rawScopeId
						: null;
			const updatedBy =
				typeof body["updated_by"] === "string" && body["updated_by"].length > 0
					? body["updated_by"]
					: "api";

			const result = await putSetting(ctx.handle, ctx.events, {
				scope,
				scopeId,
				key,
				value: body["value"],
				updatedBy,
			});

			if (!result.ok) {
				const httpStatus =
					result.reason === "unknown_key" ||
					result.reason === "wrong_scope" ||
					result.reason === "scope_id_required" ||
					result.reason === "invalid_value"
						? 400
						: 400;
				return jsonError(httpStatus, result.reason, result.message);
			}

			return json(result.row);
		},
	},

	// -------------------------------------------------------------------------
	// DELETE /settings/:scope/:key — revert to default
	// -------------------------------------------------------------------------
	{
		method: "DELETE",
		path: "/settings/:scope/:key",
		auth: true,
		summary: "Revert a settings override to default. ?scope_id=",
		handler: async (ctx) => {
			const scope = parseScope(ctx.params.scope ?? "");
			if (scope === null) {
				return jsonError(
					400,
					"invalid_scope",
					`scope must be one of: ${SETTING_SCOPES.join(", ")}`,
				);
			}

			const key = ctx.params.key ?? "";
			if (!key) {
				return jsonError(400, "invalid_param", "key is required");
			}

			const rawScopeId = ctx.url.searchParams.get("scope_id");
			const scopeId = rawScopeId !== null ? Number(rawScopeId) : null;
			if (rawScopeId !== null && !Number.isInteger(scopeId)) {
				return jsonError(400, "invalid_param", "scope_id must be an integer");
			}

			const result = await deleteSetting(ctx.handle, ctx.events, {
				scope,
				scopeId,
				key,
				updatedBy: ctx.url.searchParams.get("updated_by") ?? "api",
			});

			if (!result.ok) {
				return jsonError(404, result.reason, result.message);
			}

			return json({ ok: true });
		},
	},

	// -------------------------------------------------------------------------
	// GET /settings/audit — audit events
	// -------------------------------------------------------------------------
	{
		method: "GET",
		path: "/settings/audit",
		auth: true,
		summary: "Settings audit events (settings.updated, settings.reverted), newest first. ?limit=",
		handler: (ctx) => {
			const limit = parseLimit(ctx.url.searchParams.get("limit"), 100);
			const rows = listAuditEvents(ctx.handle, { limit });
			return json(rows);
		},
	},
];
