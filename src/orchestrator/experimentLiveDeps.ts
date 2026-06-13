/**
 * WHY: The LIVE side-effects for the experiment hill-climb loop (§3.11) — the real
 * git / eval / agent-spawn implementations that dispatchExperiment injects as
 * `experimentDeps` on a wired host. Without this only makeFailClosedExperimentDeps
 * exists (refuses everything). This makes experiments genuinely runnable.
 *
 * §3.12.8 EVAL ISOLATION (the load-bearing security invariant): evalRunner runs
 * eval_command on a SEPARATE, detached git worktree checked out at the candidate
 * commit — NEVER in the agent's editing worktree. The agent edits only
 * target_paths in `repoDir`; the score is computed against a clean checkout of the
 * COMMITTED state, in a different directory, so the agent cannot tamper with its
 * own score (the engine additionally validates eval_command lives OUTSIDE
 * target_paths). The eval worktree is always removed in a finally block.
 *
 * FAIL-CLOSED: produceEdit returns {ok:false} on any spawn failure (never pretends
 * an edit happened); commit returns {ok:false} when there is nothing to commit;
 * evalRunner returns {ok:false} on non-zero exit / timeout. Every side effect is
 * injectable (git / spawner / exec) so this is testable with fakes — no real
 * git/agent/subprocess in tests.
 */

import { join } from "node:path";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { ExperimentRunDeps } from "./experimentRun.ts";
import { execGit } from "../worktree/git.ts";
import { removeWorktree } from "../worktree/worktree.ts";
import {
	spawnOneShotCaptured,
	buildOneShotArgv,
	type OneShotSpawner,
} from "../runs/liveSpawn.ts";

/** Injectable eval subprocess seam — runs a command in cwd with a wall-clock budget. */
export type EvalExec = (
	cmd: string[],
	opts: { cwd: string; timeoutMs: number },
) => Promise<{ ok: boolean; stdout: string }>;

/** Injectable git runner (default execGit). */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export interface LiveExperimentDepsInput {
	handle: DbHandle;
	log: EventLog;
	/** The agent's editing worktree (where target_paths are mutated). */
	repoDir: string;
	/** Per-task HOME root for the produceEdit agent one-shot. */
	homeRoot: string;
	/** Provider for the produceEdit agent turn (default "claude-code"). */
	provider?: string;
	/** Default execGit. */
	git?: GitRunner;
	/** Default spawnOneShotCaptured (produceEdit). */
	spawner?: OneShotSpawner;
	/** Default Bun.spawn-based exec (evalRunner). */
	exec?: EvalExec;
	now?: () => number;
}

/** Default eval exec: Bun.spawn with a hard wall-clock kill. */
const defaultExec: EvalExec = async (cmd, opts) => {
	const proc = Bun.spawn(cmd, {
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, LC_ALL: "C" },
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, opts.timeoutMs);
	try {
		const stdout = await new Response(proc.stdout).text();
		const code = await proc.exited;
		return { ok: !timedOut && code === 0, stdout };
	} finally {
		clearTimeout(timer);
	}
};

function providerAuthDir(home: string, provider: string): string {
	return provider === "codex" ? `${home}/.codex` : `${home}/.claude`;
}

/**
 * Build the production ExperimentRunDeps. A live host passes this to
 * dispatchExperiment's `experimentDeps`. All sub-seams are injectable.
 */
export function makeLiveExperimentDeps(input: LiveExperimentDepsInput): ExperimentRunDeps {
	const git = input.git ?? execGit;
	const spawner = input.spawner ?? spawnOneShotCaptured;
	const exec = input.exec ?? defaultExec;
	const provider = input.provider ?? "claude-code";
	const repoDir = input.repoDir;
	const home = `${input.homeRoot}/experiment`;
	const nowFn = input.now ?? (() => Date.now());

	return {
		handle: input.handle,
		log: input.log,
		now: nowFn,

		async produceEdit(ctx) {
			// One agent turn: improve the metric by editing ONLY target_paths.
			const lines = [
				"You are running ONE iteration of an automated optimisation experiment.",
				`Iteration: ${ctx.iteration}.`,
				ctx.lastMetric === null
					? "No metric has been recorded yet."
					: `Current best metric value: ${ctx.lastMetric}.`,
				"",
				"Make a SINGLE focused change you believe improves the target metric.",
				"You may ONLY edit these paths (editing anything else is forbidden):",
				...ctx.targetPaths.map((p) => `  - ${p}`),
				"",
				"Do not run the evaluation yourself and do not commit — just make the edit and stop.",
			];
			try {
				await spawner({
					argv: buildOneShotArgv(provider),
					prompt: lines.join("\n"),
					cwd: repoDir,
					home,
					providerAuthDir: providerAuthDir(home, provider),
				});
				return { ok: true };
			} catch (err) {
				// Fail-closed: a failed/absent agent turn is NOT a silent success.
				return { ok: false, reason: err instanceof Error ? err.message : String(err) };
			}
		},

		async commit(ctx) {
			// Stage everything the agent changed, commit. Nothing to commit ⇒ ok:false
			// (the iteration produced no change → engine discards it).
			await git(["add", "-A"], repoDir);
			const status = (await git(["status", "--porcelain"], repoDir)).trim();
			if (status.length === 0) {
				return { ok: false };
			}
			// --no-verify: host-side commit must not run repo hooks (§3.12.25 spirit).
			await git(["commit", "--no-verify", "-m", ctx.message], repoDir);
			const sha = (await git(["rev-parse", "HEAD"], repoDir)).trim();
			return { ok: true, commitSha: sha };
		},

		async evalRunner(ctx) {
			// §3.12.8: run eval on a SEPARATE detached checkout of the commit, NOT in
			// the agent's editing worktree, so the score reflects the committed state
			// and the agent cannot tamper with the scorer.
			const ref = ctx.commitSha ?? "HEAD";
			const evalDir = join(
				repoDir,
				".nightshift",
				"worktrees",
				`eval-${ref.slice(0, 12)}-${nowFn()}`,
			);
			try {
				await git(["worktree", "add", "--detach", evalDir, ref], repoDir);
			} catch (err) {
				return { ok: false, stdout: err instanceof Error ? err.message : String(err) };
			}
			try {
				const result = await exec(["sh", "-c", ctx.evalCommand], {
					cwd: evalDir,
					timeoutMs: ctx.budgetMs,
				});
				return { ok: result.ok, stdout: result.stdout };
			} finally {
				// Always remove the eval worktree (best-effort; pruneStale is the backstop).
				try {
					await git(["worktree", "remove", "--force", evalDir], repoDir);
				} catch {
					try {
						await removeWorktree(evalDir);
					} catch {
						// Backstop: pruneStale(repoDir) cleans orphans on the next sweep.
					}
				}
			}
		},

		parseMetric(stdout, metricName) {
			// Prefer a JSON object carrying the metric; fall back to a name:value regex.
			const trimmed = stdout.trim();
			try {
				const parsed = JSON.parse(trimmed) as unknown;
				if (parsed !== null && typeof parsed === "object" && metricName in parsed) {
					const v = (parsed as Record<string, unknown>)[metricName];
					if (typeof v === "number" && Number.isFinite(v)) return v;
				}
			} catch {
				// not JSON — fall through to regex
			}
			const re = new RegExp(`${metricName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:=]\\s*(-?[0-9]+(?:\\.[0-9]+)?)`);
			const m = trimmed.match(re);
			if (m && m[1] !== undefined) {
				const n = Number(m[1]);
				if (Number.isFinite(n)) return n;
			}
			return null;
		},

		async reset(ctx) {
			// Discard the iteration: reset to the prior good commit (or HEAD) + clean
			// untracked files the agent may have created.
			if (ctx.toCommitSha) {
				await git(["reset", "--hard", ctx.toCommitSha], repoDir);
			} else {
				await git(["reset", "--hard"], repoDir);
			}
			await git(["clean", "-fd"], repoDir);
		},
	};
}
