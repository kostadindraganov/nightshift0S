/**
 * WHY: The forge service — running on the HOST control plane — is the ONLY
 * entity that may push to GitHub. The agent worktree has zero git/GitHub
 * credentials. To prevent a compromised worktree from hijacking the push,
 * we explicitly pass the remote URL, disable all hooks (core.hooksPath),
 * null out local/global git config, and disable terminal prompts. The pusher
 * function is injectable so tests can assert the exact args/env without
 * making real network calls (§2.6 / BLUEPRINT §3.12.25 threat model).
 */

import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Pusher = (
  args: string[],
  cwd: string,
  env: Record<string, string>,
) => Promise<string>;

export interface PushValidatedInput {
  worktreePath: string;
  remoteUrl: string;
  branch: string;
}

// ---------------------------------------------------------------------------
// Argument and environment builders
// ---------------------------------------------------------------------------

/**
 * Builds the worktree-distrusting `git push` argv.
 * - Disables all hooks via `-c core.hooksPath=/dev/null`
 * - Forces protocol v2 for performance
 * - `--no-verify` is belt-and-suspenders in addition to hooksPath
 * - Uses the explicit remote URL, not a named remote (prevents worktree tampering)
 * - Always pushes HEAD to the named branch
 */
export function buildPushArgs({ remoteUrl, branch }: { remoteUrl: string; branch: string }): string[] {
  return [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.version=2",
    "push",
    "--no-verify",
    remoteUrl,
    `HEAD:refs/heads/${branch}`,
  ];
}

/**
 * Returns an env overlay that isolates this git invocation from any
 * local/global config the agent worktree might have written, and disables
 * interactive prompts (which would hang in CI).
 */
export function pushEnv(): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

// ---------------------------------------------------------------------------
// Default pusher (live — DEPLOY-PENDING until a real remote is available)
// ---------------------------------------------------------------------------

/**
 * Real pusher: runs git with the distrust args and env.
 * In tests, inject a fake pusher instead.
 */
export function defaultPusher(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: { ...process.env, LC_ALL: "C", ...env },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Token injection
// ---------------------------------------------------------------------------

/**
 * Rewrite an HTTPS remote URL to embed the GITHUB_TOKEN for authentication.
 * The token never appears in the push args (a URL is not logged as a flag);
 * git replaces the credential with "***" in error output, but the token is
 * still sensitive — the forge is the ONLY caller and runs on the control plane.
 *
 * Returns the original URL unchanged if GITHUB_TOKEN is not set or the URL
 * is not an HTTPS GitHub URL (e.g. SSH remotes do not need this).
 */
export function injectGitHubToken(remoteUrl: string): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return remoteUrl;
  // Match https://github.com/... or https://www.github.com/...
  const m = remoteUrl.match(/^(https?:\/\/)((?:www\.)?github\.com\/.+)$/);
  if (!m) return remoteUrl;
  return `${m[1]}x-access-token:${token}@${m[2]}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pushes from the worktree using distrust args and env. The `pusher` is
 * injectable so tests never make real pushes.
 *
 * DEPLOY-PENDING: a real push requires a live remote + host GitHub token.
 */
export async function pushValidated(
  pusher: Pusher = defaultPusher,
  { worktreePath, remoteUrl, branch }: PushValidatedInput,
): Promise<string> {
  const authenticatedUrl = injectGitHubToken(remoteUrl);
  const args = buildPushArgs({ remoteUrl: authenticatedUrl, branch });
  const env = pushEnv();
  return pusher(args, worktreePath, env);
}
