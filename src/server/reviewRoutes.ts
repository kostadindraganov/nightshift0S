/**
 * HTTP routes for the review subsystem (Phase 3 / GATE 3).
 *
 * WHY this file exists: the review orchestrator (runReviewRound, applyHumanVerdict)
 * and the thread/findings read paths need HTTP endpoints. ReviewDeps requires
 * production-wired collaborators (threadApi, runVerdict, codeReviewJudge,
 * getDiff, runReviewer, resumeCoder) that RouteContext does not carry — so we
 * export a factory `makeReviewRoutes(cfg)` instead of a bare const array. The
 * INTEGRATION phase wires it into routes.ts via `...makeReviewRoutes({ buildDeps })`.
 */

import type { Route, RouteContext } from "./routes.ts";
import { json, jsonError } from "./routes.ts";
import { ValidationError } from "../tasks/tasks.ts";
import { getTask } from "../tasks/tasks.ts";
import type { ReviewDeps } from "../orchestrator/review.ts";
import { runReviewRound, applyHumanVerdict } from "../orchestrator/review.ts";
import { getThread, listFindings } from "../thread/thread.ts";

// ---------------------------------------------------------------------------
// Config + factory

export interface ReviewRoutesConfig {
	/** Integration supplies production wiring (threadApi, runVerdict, codeReviewJudge,
	 *  real getDiff/runReviewer/resumeCoder). handle/log come from ctx. */
	buildDeps: (ctx: RouteContext) => ReviewDeps;
}

// ---------------------------------------------------------------------------
// Helpers

function parseTaskId(raw: string | undefined): number {
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		throw new ValidationError("task id must be a positive integer");
	}
	return n;
}

/** Parse the request body as a plain JSON object; 400 if not. */
async function readBody(req: Request): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		throw new ValidationError("Request body must be valid JSON");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new ValidationError("Request body must be a JSON object");
	}
	return body as Record<string, unknown>;
}

const VALID_DECISIONS = ["resume_coding", "force_merge", "reject"] as const;
type HumanDecision = (typeof VALID_DECISIONS)[number];

function assertDecision(raw: unknown): HumanDecision {
	if (!VALID_DECISIONS.includes(raw as HumanDecision)) {
		throw new ValidationError(
			`decision must be one of: ${VALID_DECISIONS.join(", ")}`,
		);
	}
	return raw as HumanDecision;
}

// ---------------------------------------------------------------------------
// Route handlers (closures over cfg)

function makeHandlers(cfg: ReviewRoutesConfig) {
	function handleGetThread(ctx: RouteContext): Response {
		const id = parseTaskId(ctx.params.id);
		const task = getTask(ctx.handle, id);
		if (!task) return jsonError(404, "not_found", `task ${id} not found`);
		return json(getThread(ctx.handle, id));
	}

	function handleGetFindings(ctx: RouteContext): Response {
		const id = parseTaskId(ctx.params.id);
		const task = getTask(ctx.handle, id);
		if (!task) return jsonError(404, "not_found", `task ${id} not found`);
		const rawRound = ctx.url.searchParams.get("round");
		const round =
			rawRound !== null
				? (() => {
						const n = Number(rawRound);
						if (!Number.isInteger(n) || n < 1) {
							throw new ValidationError("round must be a positive integer");
						}
						return n;
					})()
				: undefined;
		return json(listFindings(ctx.handle, id, round));
	}

	async function handleReviewRound(ctx: RouteContext): Promise<Response> {
		const id = parseTaskId(ctx.params.id);
		const deps = cfg.buildDeps(ctx);
		const result = await runReviewRound(deps, id);
		if (!result.ok) {
			return jsonError(409, "not_reviewable", result.reason);
		}
		return json(result);
	}

	async function handleVerdict(ctx: RouteContext): Promise<Response> {
		const id = parseTaskId(ctx.params.id);
		const body = await readBody(ctx.req);
		const decision = assertDecision(body.decision);
		const actor =
			typeof body.actor === "string" && body.actor.length > 0
				? body.actor
				: "human:api";
		const deps = cfg.buildDeps(ctx);
		const result = await applyHumanVerdict(deps, id, { decision, actor });
		if (!result.ok) {
			return jsonError(409, "not_reviewable", result.reason);
		}
		return json(result);
	}

	return { handleGetThread, handleGetFindings, handleReviewRound, handleVerdict };
}

// ---------------------------------------------------------------------------
// Factory

export function makeReviewRoutes(cfg: ReviewRoutesConfig): Route[] {
	const { handleGetThread, handleGetFindings, handleReviewRound, handleVerdict } =
		makeHandlers(cfg);

	return [
		{
			method: "GET",
			path: "/tasks/:id/thread",
			auth: true,
			summary: "Fetch the append-only thread for a task",
			handler: handleGetThread,
		},
		{
			method: "GET",
			path: "/tasks/:id/findings",
			auth: true,
			summary: "List review findings for a task; ?round= filters by review round",
			handler: handleGetFindings,
		},
		{
			method: "POST",
			path: "/tasks/:id/review-round",
			auth: true,
			summary: "Run one reviewer turn; task must be in state=review",
			handler: handleReviewRound,
		},
		{
			method: "POST",
			path: "/tasks/:id/verdict",
			auth: true,
			summary: "Apply a human verdict on a needs_human task: resume_coding | force_merge | reject",
			handler: handleVerdict,
		},
	];
}
