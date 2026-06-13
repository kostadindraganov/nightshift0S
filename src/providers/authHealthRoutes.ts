/**
 * WHY: HTTP surface for the auth health panel (BLUEPRINT §3.9).
 * A single GET returns the stored-state snapshot for all providers so
 * operators and the UI can detect auth problems before runs start failing.
 *
 * No writes, no probe (probe wiring is a deployment-time integration
 * concern). The handler is intentionally minimal — snapshotAuthHealth
 * owns all the logic and is tested independently.
 */

import type { Route } from "../server/routes.ts";
import { json } from "../server/routes.ts";
import { snapshotAuthHealth } from "./authHealth.ts";

export const authHealthRoutes: Route[] = [
	{
		method: "GET",
		path: "/providers/health",
		auth: true,
		summary:
			"Auth health snapshot for all providers: login state, key validity, circuit/cooldown (§3.9)",
		handler: (ctx) => json(snapshotAuthHealth(ctx.handle, new Date())),
	},
];
