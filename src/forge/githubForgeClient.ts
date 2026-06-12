/**
 * WHY: The host-side forge service needs a real GitHub token at runtime, but
 * the two sources (env var vs. `gh` CLI) have different failure modes and
 * latency characteristics. Centralising resolution here means every caller
 * gets fail-closed behaviour — a missing token throws immediately rather than
 * silently sending unauthorised requests. Bun.spawn is used (instead of
 * node:child_process) to stay consistent with the Bun runtime used throughout
 * this project. The token is NEVER forwarded to agent environments; this
 * module must only be imported and instantiated on the host control plane
 * (§2.6 / BLUEPRINT §3.12.25 threat model).
 *
 * defaultPusher (src/forge/push.ts) is the live Pusher: it shells out to
 * `git push` with worktree-distrusting flags (core.hooksPath=/dev/null,
 * GIT_CONFIG_GLOBAL=/dev/null, --no-verify) and is already exported from
 * push.ts as the default parameter of pushValidated(). Callers that need a
 * real push simply omit the pusher argument.
 */

import { GitHubRestClient } from "./github.ts";
import type { ForgeClient } from "./github.ts";

// ---------------------------------------------------------------------------
// Injectable spawn type — the narrow subset of Bun.spawn we consume
// ---------------------------------------------------------------------------

export interface SpawnResult {
	exited: Promise<number>;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
}

export type Spawner = (cmd: string[]) => SpawnResult;

/** Production spawner — thin wrapper around Bun.spawn. */
export function defaultSpawner(cmd: string[]): SpawnResult {
	return Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a GitHub personal-access token for the host forge service.
 *
 * Resolution order:
 *   1. process.env.GITHUB_TOKEN (cheapest — no subprocess)
 *   2. `gh auth token` via the injected spawner (defaults to Bun.spawn)
 *
 * Throws if neither source yields a non-empty token. FAIL-CLOSED by design —
 * callers must not proceed without a valid token.
 *
 * @param spawner Injectable spawn function — tests pass a stub, production
 *                leaves it as the default so Bun.spawn is used.
 */
export async function resolveGitHubToken(
	spawner: Spawner = defaultSpawner,
): Promise<string> {
	const envToken = process.env["GITHUB_TOKEN"];
	if (envToken && envToken.trim().length > 0) {
		return envToken.trim();
	}

	// Fallback: ask the gh CLI (host-only — never call from an agent worktree)
	const proc = spawner(["gh", "auth", "token"]);

	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const token = stdout.trim();

	if (exitCode !== 0 || token.length === 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(
			`GitHub token resolution failed: GITHUB_TOKEN is unset and ` +
			`\`gh auth token\` exited ${exitCode}: ${stderr.trim() || "(no output)"}`,
		);
	}

	return token;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a production ForgeClient backed by a real GitHub token.
 * Resolves the token via resolveGitHubToken() and wraps it in GitHubRestClient.
 *
 * HOST-SIDE ONLY. Never call from agent sandbox code.
 *
 * @param baseUrl Override for GitHub Enterprise. Defaults to https://api.github.com.
 * @param spawner Injectable spawn function for tests. Leave undefined in production.
 */
export async function createGitHubForgeClient(
	baseUrl = "https://api.github.com",
	spawner: Spawner = defaultSpawner,
): Promise<ForgeClient> {
	const token = await resolveGitHubToken(spawner);
	return new GitHubRestClient(token, baseUrl);
}
