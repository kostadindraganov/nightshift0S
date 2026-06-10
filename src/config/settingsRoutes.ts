/**
 * Read-only config API route (task 1.7, §3.12.19).
 *
 * WHY read-only: V1 config comes from a file + env vars, not a DB registry.
 * The editable DB-backed settings UI is a V1.5 concern. This endpoint exposes
 * every knob so operators and the settings UI can inspect the live config
 * without SSH-ing into the box.
 *
 * WHY scope:"global": V1 has a single config scope. The field is included now
 * so the settings UI can filter by scope in V1.5 without a schema change.
 */

import type { Route } from "../server/routes.ts";
import { describeConfig, loadConfigWithSources } from "./config.ts";

export const configRoutes: Route[] = [
	{
		method: "GET",
		path: "/config",
		auth: true,
		summary: "Read-only config registry: every knob with value, source, and scope (§3.12.19)",
		handler: () => {
			const { config, sources } = loadConfigWithSources();
			const entries = describeConfig(config, sources).map((entry) => ({
				...entry,
				scope: "global",
			}));
			return Response.json(entries);
		},
	},
];
