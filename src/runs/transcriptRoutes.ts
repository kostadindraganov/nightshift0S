/**
 * WHY: HTTP routes for the transcript browser (BLUEPRINT §3.12.16).
 *
 * Two endpoints expose the merged event envelopes produced by `transcript.ts`:
 *   GET /runs/:id/transcript  — run-scoped transcript (merged events + thread_events)
 *   GET /tasks/:id/transcript — task-scoped transcript with optional pagination
 *
 * Both are read-only. Neither returns 404 on an empty result set — an empty
 * array is valid (a newly created run or task has no events yet). 400 is
 * returned when query parameters cannot be parsed as integers.
 */

import type { Route, RouteContext } from "../server/routes.ts";
import { json, jsonError } from "../server/routes.ts";
import { buildRunTranscript, buildTaskTranscript } from "./transcript.ts";

// ---------------------------------------------------------------------------
// Helpers

/**
 * Parse an optional query-string param as an integer.
 * Returns null when the param is absent; returns a 400 Response when the
 * value is present but not a valid integer.
 */
function parseIntQuery(
	raw: string | null,
	name: string,
): { ok: true; value: number | null } | { ok: false; response: Response } {
	if (raw === null) return { ok: true, value: null };
	const n = Number(raw);
	if (!Number.isInteger(n)) {
		return {
			ok: false,
			response: jsonError(400, "bad_request", `${name} must be an integer`),
		};
	}
	return { ok: true, value: n };
}

/**
 * Parse a required path param as a positive integer.
 * Returns a 400 Response when the value is missing or not a valid integer.
 */
function parsePathId(
	raw: string | undefined,
	name: string,
): { ok: true; value: number } | { ok: false; response: Response } {
	if (raw === undefined) {
		return { ok: false, response: jsonError(400, "bad_request", `${name} is required`) };
	}
	const n = Number(raw);
	if (!Number.isInteger(n)) {
		return {
			ok: false,
			response: jsonError(400, "bad_request", `${name} must be an integer`),
		};
	}
	return { ok: true, value: n };
}

// ---------------------------------------------------------------------------
// Handlers

async function handleRunTranscript(ctx: RouteContext): Promise<Response> {
	const idParsed = parsePathId(ctx.params.id, "run id");
	if (!idParsed.ok) return idParsed.response;
	const runId = idParsed.value;

	const transcript = buildRunTranscript(ctx.handle, runId);
	return json(transcript);
}

async function handleTaskTranscript(ctx: RouteContext): Promise<Response> {
	const idParsed = parsePathId(ctx.params.id, "task id");
	if (!idParsed.ok) return idParsed.response;
	const taskId = idParsed.value;

	// Parse optional query params; any non-integer value is a 400.
	const roundResult = parseIntQuery(ctx.url.searchParams.get("round"), "round");
	if (!roundResult.ok) return roundResult.response;

	const afterSeqResult = parseIntQuery(ctx.url.searchParams.get("after_seq"), "after_seq");
	if (!afterSeqResult.ok) return afterSeqResult.response;

	const limitResult = parseIntQuery(ctx.url.searchParams.get("limit"), "limit");
	if (!limitResult.ok) return limitResult.response;

	const transcript = buildTaskTranscript(ctx.handle, taskId, {
		...(roundResult.value !== null ? { round: roundResult.value } : {}),
		...(afterSeqResult.value !== null ? { afterSeq: afterSeqResult.value } : {}),
		...(limitResult.value !== null ? { limit: limitResult.value } : {}),
	});

	return json(transcript);
}

// ---------------------------------------------------------------------------
// Route table

export const transcriptRoutes: Route[] = [
	{
		method: "GET",
		path: "/runs/:id/transcript",
		auth: true,
		summary: "Merged transcript of global events + thread_events for a run",
		handler: handleRunTranscript,
	},
	{
		method: "GET",
		path: "/tasks/:id/transcript",
		auth: true,
		summary:
			"Merged transcript for a task; optional ?round= &after_seq= &limit= pagination",
		handler: handleTaskTranscript,
	},
];
