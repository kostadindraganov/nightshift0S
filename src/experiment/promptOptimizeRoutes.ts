/**
 * WHY: HTTP surface for prompt self-optimization (BLUEPRINT §3.11 V3, task 7.6).
 * POST /routines/:id/prompt-optimize runs a synchronous hill-climb over a seed
 * prompt for up to `maxRounds` LLM propose/evaluate rounds (capped at 5).
 *
 * The `propose` and `evaluate` deps are live one-shot LLM calls via the default
 * coder provider (NIGHTSHIFT_CLAUDE_AUTH_DIR must point to a non-/home copy of
 * the provider auth dir — same requirement as the interactive coder runs).
 *
 * FAIL-CLOSED: OneShotDisabledError (unknown provider, absent bwrap, timeout)
 * surfaces as 503. An empty proposed prompt or unparseable score is caught by
 * optimizePrompt's NEVER-STOP discipline and recorded as a discarded step.
 * The routine must exist (404 otherwise); its id scopes the sandbox home dir.
 */

import { mkdirSync } from "node:fs";
import { json, jsonError } from "../server/routes.ts";
import type { Route, RouteContext } from "../server/routes.ts";
import { optimizePrompt } from "./promptOptimize.ts";
import { buildOneShotArgv, spawnOneShotCaptured } from "../runs/liveSpawn.ts";
import { getRoutine } from "../triggers/routines.ts";
import { loadConfig } from "../config/config.ts";

const MAX_ROUNDS_CAP = 5;

async function handlePromptOptimize(ctx: RouteContext): Promise<Response> {
	const routineId = Number(ctx.params.id);
	if (!Number.isInteger(routineId) || routineId <= 0) {
		return jsonError(400, "bad_request", "id must be a positive integer");
	}

	const routine = getRoutine(ctx.handle, routineId);
	if (!routine) return jsonError(404, "not_found", "routine not found");

	let body: unknown;
	try {
		body = await ctx.req.json();
	} catch {
		return jsonError(400, "bad_request", "request body must be valid JSON");
	}
	if (typeof body !== "object" || body === null) {
		return jsonError(400, "bad_request", "request body must be a JSON object");
	}
	const b = body as Record<string, unknown>;

	if (typeof b.seedPrompt !== "string" || b.seedPrompt.trim().length === 0) {
		return jsonError(400, "bad_request", "seedPrompt must be a non-empty string");
	}
	const seedPrompt = b.seedPrompt.trim();
	const taskDescription =
		typeof b.taskDescription === "string" ? b.taskDescription.trim() : "";
	const rawRounds = Number(b.maxRounds);
	const maxRounds =
		Number.isInteger(rawRounds) && rawRounds > 0
			? Math.min(rawRounds, MAX_ROUNDS_CAP)
			: 2;

	const cfg = loadConfig();
	const provider = cfg.providers.defaultCoder;
	const homeBase = `${cfg.sandbox.homeRoot}/prompt-optimize/${routineId}`;
	const providerAuthDir =
		provider === "codex" ? `${homeBase}/.codex` : `${homeBase}/.claude`;
	mkdirSync(providerAuthDir, { recursive: true });

	let argv: string[];
	try {
		argv = buildOneShotArgv(provider);
	} catch (err) {
		return jsonError(
			503,
			"service_unavailable",
			err instanceof Error ? err.message : String(err),
		);
	}

	async function callLlm(prompt: string): Promise<string> {
		const { stdout } = await spawnOneShotCaptured({
			argv,
			prompt,
			cwd: homeBase,
			home: homeBase,
			providerAuthDir,
		});
		return stdout;
	}

	const deps = {
		maxRounds,
		propose: async (current: string, round: number): Promise<string> => {
			const prompt = taskDescription
				? `Task this prompt must accomplish:\n${taskDescription}\n\nCurrent prompt (round ${round}):\n${current}\n\nPropose an improved version that is clearer, more specific, and more likely to produce good results. Output ONLY the improved prompt text, no explanation or preamble.`
				: `Current prompt (round ${round}):\n${current}\n\nPropose an improved version that is clearer, more specific, and more effective. Output ONLY the improved prompt text, no explanation or preamble.`;
			const stdout = await callLlm(prompt);
			const improved = stdout.trim();
			if (improved.length === 0) throw new Error("empty proposed prompt");
			return improved;
		},
		evaluate: async (prompt: string): Promise<number> => {
			const evalPrompt = taskDescription
				? `Task this prompt must accomplish:\n${taskDescription}\n\nPrompt to score:\n${prompt}\n\nScore this prompt from 0 to 100 for how well it would accomplish the task (clarity, specificity, effectiveness). Output ONLY the integer score, nothing else.`
				: `Prompt to score:\n${prompt}\n\nScore this prompt from 0 to 100 for clarity and effectiveness. Output ONLY the integer score, nothing else.`;
			const stdout = await callLlm(evalPrompt);
			const match = stdout.trim().match(/\d+/);
			if (!match) throw new Error(`could not parse score from: ${stdout.slice(0, 100)}`);
			return Math.min(100, Math.max(0, Number(match[0])));
		},
	};

	try {
		const result = await optimizePrompt(deps, seedPrompt);
		return json({ routineId, maxRounds, ...result });
	} catch (err) {
		return jsonError(
			503,
			"optimize_failed",
			err instanceof Error ? err.message : String(err),
		);
	}
}

export const promptOptimizeRoutes: Route[] = [
	{
		method: "POST",
		path: "/routines/:id/prompt-optimize",
		auth: true,
		summary:
			"Hill-climb a prompt over N LLM rounds using the default coder provider (§3.11 V3 prompt self-optimization)",
		handler: handlePromptOptimize,
	},
];
