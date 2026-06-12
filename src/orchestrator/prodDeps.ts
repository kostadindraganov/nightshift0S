/**
 * WHY: Host-side factory that assembles the LIVE collaborators the autonomous
 * coder orchestrator (`completeCoderRun`, src/orchestrator/coder.ts) needs to go
 * to production — the live GitHub `ForgeClient`, the live GitHub-Checks
 * `CiClient`, and `defaultPusher` (git-over-SSH) — into a single
 * `CoderOrchestratorDeps`.
 *
 * WIRING POINT (the answer to "where does completeCoderRun get its live deps").
 * As of this wave there is NO production caller of `completeCoderRun`: the
 * run-completion trigger (reaper/watchdog → orchestrator) and the merge-webhook
 * listener are explicit NON-GOALS of LIVE-WIRING-CONTRACT §4, and the
 * reaper/watchdog are sealed ("complete") per §2. So rather than invent a
 * caller (which would create a live side-effect path the contract forbids this
 * wave), this module supplies the deps factory the future trigger will call:
 *
 *     const deps = await buildProdCoderDeps({ handle, log, resolveRepo });
 *     await completeCoderRun(deps, runId);
 *
 * FAIL-CLOSED-ON-INVOKE, NEVER AT BOOT. `buildProdCoderDeps` is async because
 * it resolves the GitHub token (env GITHUB_TOKEN → `gh auth token`) exactly
 * once, host-side, at the moment a run completes — NOT at server boot. A missing
 * token THROWS here (`createGitHubForgeClient` / `GitHubCiClient` ctor), so the
 * orchestrator can never push or open a PR on an unwired host. Nothing in this
 * module runs unless a caller awaits the factory.
 *
 * HOST-SIDE TOKEN INVARIANT (§0 / BLUEPRINT §3.12.25): the token lives ONLY
 * inside `GitHubRestClient` and the `GitHubCiClient` built here. It is never
 * placed in any agent env — `defaultPusher` uses git-over-SSH (the host's
 * ssh-agent), no token involved. This module must only ever be imported on the
 * host control plane, never from sandbox/agent code.
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { TaskRow, RunRow } from "../db/schema.ts";
import type { CoderOrchestratorDeps, RepoConfig } from "./coder.ts";
import { resolveGitHubToken, type Spawner } from "../forge/githubForgeClient.ts";
import { GitHubRestClient } from "../forge/github.ts";
import { defaultPusher } from "../forge/push.ts";
import { GitHubCiClient } from "../gate/githubCiClient.ts";

export interface ProdCoderDepsInput {
	handle: DbHandle;
	log: EventLog;
	/**
	 * Resolves the per-task/run repo coordinates (local repoDir, worktree,
	 * remote URL, owner/repo, default branch, required checks). The caller owns
	 * this because only it knows how the project's remote `repoUrl` maps to a
	 * local checkout on the host. `owner`/`repo` from the same source feed the
	 * live `CiClient` below.
	 */
	resolveRepo: (task: TaskRow, run: RunRow) => RepoConfig;
	/**
	 * owner/repo for the live GitHub-Checks `CiClient`. The CiClient is shared
	 * across the run (it is not resolved per-task), so the caller supplies the
	 * single repo this orchestrator instance targets — the same owner/repo it
	 * returns from `resolveRepo`.
	 */
	owner: string;
	repo: string;
	/** GitHub API base; override for GitHub Enterprise. */
	baseUrl?: string;
	/**
	 * Injectable spawner for the host-side `gh auth token` fallback (used only
	 * when GITHUB_TOKEN is unset). Production leaves it undefined so Bun.spawn is
	 * used; tests inject a stub so no real subprocess is ever created.
	 */
	spawner?: Spawner;
}

/**
 * Assemble the production `CoderOrchestratorDeps` with live forge + CI clients
 * and the default git-over-SSH pusher. Resolves the GitHub token ONCE (throws
 * if unavailable — fail-closed) and feeds it to BOTH clients so the token lives
 * on exactly one host-side resolution path and never crosses into an agent
 * env. `git` is left undefined so the orchestrator falls back to host-side
 * `execGit`.
 */
export async function buildProdCoderDeps(
	input: ProdCoderDepsInput,
): Promise<CoderOrchestratorDeps> {
	const baseUrl = input.baseUrl ?? "https://api.github.com";
	// Resolve the token once, host-side, at invocation (never at boot). A missing
	// token throws here — the orchestrator can never push/open a PR unwired.
	const token = await resolveGitHubToken(input.spawner);
	const forgeClient = new GitHubRestClient(token, baseUrl);
	const ci = new GitHubCiClient(input.owner, input.repo, token, baseUrl);
	return {
		handle: input.handle,
		log: input.log,
		forgeClient,
		pusher: defaultPusher,
		ci,
		resolveRepo: input.resolveRepo,
	};
}
