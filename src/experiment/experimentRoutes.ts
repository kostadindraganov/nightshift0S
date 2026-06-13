/**
 * WHY: HTTP surface for the experiment ledger (BLUEPRINT §3.11). A single
 * read-only GET returns the iteration ledger, the metric series for the UI
 * chart, and the best kept entry for one experiment routine run.
 *
 * No writes, no agent/git/eval — safe on macOS. The route never runs the loop;
 * it only reads what engine.ts/ledger.ts persisted. 400 is returned when the
 * run id path param is not a valid integer; an empty ledger is a valid 200
 * (a routine run that has not iterated yet has no rows).
 */

import type { Route, RouteContext } from "../server/routes.ts";
import { json, jsonError } from "../server/routes.ts";
import { bestEntry, listLedger, metricSeries } from "./ledger.ts";

// The ledger row does not persist the metric direction, so "best" is resolved
// with the optional ?direction= query param (defaults to "lower").

function parsePathId(
	raw: string | undefined,
	name: string,
): { ok: true; value: number } | { ok: false; response: Response } {
	const n = Number(raw);
	if (raw === undefined || !Number.isInteger(n)) {
		return { ok: false, response: jsonError(400, "bad_request", `${name} must be an integer`) };
	}
	return { ok: true, value: n };
}

function handleExperiment(ctx: RouteContext): Response {
	const idParsed = parsePathId(ctx.params.id, "run id");
	if (!idParsed.ok) return idParsed.response;
	const routineRunId = idParsed.value;

	const rawDirection = ctx.url.searchParams.get("direction");
	const direction = rawDirection === "higher" ? "higher" : "lower";

	const ledger = listLedger(ctx.handle, routineRunId);
	return json({
		ledger,
		series: metricSeries(ctx.handle, routineRunId),
		best: bestEntry(ledger, direction),
	});
}

export const experimentRoutes: Route[] = [
	{
		method: "GET",
		path: "/runs/:id/experiment",
		auth: true,
		summary:
			"Experiment ledger for a routine run: iteration ledger, metric series, and best kept entry (§3.11)",
		handler: handleExperiment,
	},
];
