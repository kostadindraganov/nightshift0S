/**
 * WHY: HTTP surface for the analytics module (BLUEPRINT §3.7). Read-only — a
 * single GET /analytics endpoint that combines the factory overview, per-provider
 * stats, and routing scores into one response. Query params ?since= and ?kind=
 * pass through to aggregateProviders so a dashboard can scope to a recent window
 * or a specific run kind without a separate call.
 *
 * No writes, no event emission. Wired in src/server/routes.ts by spreading
 * analyticsRoutes into the main route table.
 */

import type { Route } from "../server/routes.ts";
import { json } from "../server/routes.ts";
import { aggregateOverview, aggregateProviders } from "./aggregate.ts";
import { scoreProviders } from "./routing.ts";

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export const analyticsRoutes: Route[] = [
	{
		method: "GET",
		path: "/analytics",
		auth: true,
		summary:
			"Factory dashboard: overview counts, per-provider stats, and evidence-based routing scores. Optional ?since=<ISO8601>&kind=<run kind>.",
		handler(ctx) {
			const since = ctx.url.searchParams.get("since") ?? undefined;
			const kind = ctx.url.searchParams.get("kind") ?? undefined;

			const overview = aggregateOverview(ctx.handle);
			const providers = aggregateProviders(ctx.handle, { sinceTs: since, kind });
			const routing = scoreProviders(providers);

			return json({ overview, providers, routing });
		},
	},
];
