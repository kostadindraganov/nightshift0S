/**
 * WHY: Before the forge service pushes, it must validate that the branch name
 * and refs (baseSha, headSha) are sane. This guards against a compromised
 * worktree supplying garbage refs that could overwrite unintended remote
 * branches. The git runner is fully injectable so tests run on a real tmpdir
 * repo without network access (§2.6 / BLUEPRINT §3.12.25 threat model).
 */

import { execGit } from "../worktree/git.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export interface ValidateRefsInput {
  branch: string;
  baseSha: string;
  headSha?: string;
}

export interface ValidateRefsResult {
  ok: boolean;
  problems: string[];
}

// ---------------------------------------------------------------------------
// Branch name validation
// ---------------------------------------------------------------------------

/**
 * Returns true if `branch` is a safe ref name.
 *
 * Accepts:
 *   - Nightshift names: ns/<id>-<slug>-<rand>
 *   - Normal safe ref chars: alphanumeric, /, -, _, .
 *
 * Rejects:
 *   - Contains ".." (path traversal)
 *   - Contains spaces or whitespace
 *   - Starts with "-" (could look like a flag)
 *   - Empty string
 *   - Starts or ends with "/"
 *   - Contains consecutive "/"
 *   - Contains "@{" (git reflog shorthand)
 *   - Ends with ".lock"
 *   - Contains backslash, colon, question mark, asterisk, "[", "^", "~"
 */
export function validateBranchName(branch: string): boolean {
  if (!branch || branch.length === 0) return false;

  // git check-ref-format rejects these
  if (branch.includes("..")) return false;
  if (/\s/.test(branch)) return false;
  if (branch.startsWith("-")) return false;
  if (branch.startsWith("/")) return false;
  if (branch.endsWith("/")) return false;
  if (branch.includes("//")) return false;
  if (branch.includes("@{")) return false;
  if (branch.endsWith(".lock")) return false;
  if (branch.endsWith(".")) return false;
  if (/[\\:?*[\^~\x00-\x1f\x7f]/.test(branch)) return false;

  // Must have only safe chars: alphanumeric, /, -, _, ., @
  if (!/^[A-Za-z0-9/\-_.@]+$/.test(branch)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Ref existence validation
// ---------------------------------------------------------------------------

/**
 * Validates that baseSha (and optionally headSha) resolve to real commits in
 * the repo at `repoDir`, and that `branch` is a valid branch name.
 *
 * Uses the injected `git` runner (defaults to execGit) so tests can point at
 * a tmpdir repo without touching the nightshift repo.
 */
export async function validateRefs(
  git: GitRunner = execGit,
  repoDir: string,
  { branch, baseSha, headSha }: ValidateRefsInput,
): Promise<ValidateRefsResult> {
  const problems: string[] = [];

  // 1. Validate branch name format
  if (!validateBranchName(branch)) {
    problems.push(`Invalid branch name: ${JSON.stringify(branch)}`);
  }

  // 2. Verify baseSha resolves to a commit
  try {
    const resolved = (await git(["rev-parse", "--verify", `${baseSha}^{commit}`], repoDir)).trim();
    if (!resolved) {
      problems.push(`baseSha ${baseSha} did not resolve to a commit`);
    }
  } catch {
    problems.push(`baseSha ${baseSha} does not exist in repo`);
  }

  // 3. Verify headSha if provided
  if (headSha !== undefined) {
    try {
      const resolved = (
        await git(["rev-parse", "--verify", `${headSha}^{commit}`], repoDir)
      ).trim();
      if (!resolved) {
        problems.push(`headSha ${headSha} did not resolve to a commit`);
      }
    } catch {
      problems.push(`headSha ${headSha} does not exist in repo`);
    }
  }

  return { ok: problems.length === 0, problems };
}
