/**
 * WHY: HTTP surface for the CLI auto-update panel (BLUEPRINT V3 §cli-update).
 * A single GET returns version/update status for all configured CLI targets
 * so operators and the UI can see which agent CLIs are stale.
 *
 * Read-only — no POST update over HTTP. The handler is intentionally minimal;
 * cliUpdater owns all the logic and is tested independently.
 * Wired in src/server/routes.ts by spreading cliUpdateRoutes into the main
 * route table.
 */

import type { Route } from "../server/routes.ts";
import { json } from "../server/routes.ts";
import { cliUpdater, DEFAULT_CLI_TARGETS } from "./cliUpdate.ts";

export const cliUpdateRoutes: Route[] = [
	{
		method: "GET",
		path: "/providers/cli-status",
		auth: true,
		summary:
			"CLI version/update status for all configured agent CLIs (claude, codex, gemini, …). Read-only.",
		handler: (_ctx) => cliUpdater.status(DEFAULT_CLI_TARGETS).then(json),
	},
];
