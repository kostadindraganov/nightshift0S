/**
 * Branch-freshness gate (task 2.7).
 *
 * Before a PR opens, the task's branch must be fresh relative to the base SHA
 * recorded at claim time (§3.12.29). This module resolves a verdict without
 * performing any side effects (no actual rebase — callers do that separately).
 *
 * Verdicts:
 *   "fresh"  — baseSha === current HEAD of defaultBranch; nothing to do.
 *   "rebase" — baseSha is an ancestor of defaultBranch HEAD; the branch fell
 *              behind but the history is linear/clean. Caller should rebase
 *              before opening the PR.
 *   "block"  — history diverged, baseSha is not an ancestor, or baseSha is
 *              unknown/invalid. Requires manual intervention.
 *
 * All git I/O goes through the injected `git` runner so this function is
 * fully unit-testable without a real network or the Nightshift repo.
 */

import { execGit } from "../worktree/git.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FreshnessStatus = "fresh" | "rebase" | "block";

export interface FreshnessResult {
  status: FreshnessStatus;
  reason: string;
  /** The base SHA that was recorded at claim time. */
  baseSha: string;
  /** The current HEAD SHA of defaultBranch. */
  targetSha: string;
}

/** Minimal git runner interface — mirrors execGit's signature. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Checks whether the task branch is fresh relative to `defaultBranch`.
 *
 * @param git       Injected git runner; defaults to execGit from worktree/git.
 * @param repoDir   Absolute path to the repository root.
 * @param baseSha   SHA recorded at task-claim time.
 * @param defaultBranch  The integration branch (e.g. "main").
 */
export async function checkBranchFreshness(
  git: GitRunner = execGit,
  {
    repoDir,
    baseSha,
    defaultBranch,
  }: { repoDir: string; baseSha: string; defaultBranch: string },
): Promise<FreshnessResult> {
  // 1. Resolve the current HEAD of defaultBranch.
  let targetSha: string;
  try {
    targetSha = (
      await git(["rev-parse", `${defaultBranch}`], repoDir)
    ).trim();
  } catch {
    return {
      status: "block",
      reason: `could not resolve ${defaultBranch} HEAD`,
      baseSha,
      targetSha: "",
    };
  }

  // 2. Validate baseSha is a known object.
  try {
    await git(["cat-file", "-e", baseSha], repoDir);
  } catch {
    return {
      status: "block",
      reason: `baseSha "${baseSha}" is not a known git object`,
      baseSha,
      targetSha,
    };
  }

  // 3. Exact match — the branch is already up-to-date.
  if (baseSha === targetSha) {
    return {
      status: "fresh",
      reason: "baseSha equals current defaultBranch HEAD",
      baseSha,
      targetSha,
    };
  }

  // 4. Is baseSha an ancestor of defaultBranch HEAD?
  //    `git merge-base --is-ancestor A B` exits 0 when A is an ancestor of B.
  try {
    await git(
      ["merge-base", "--is-ancestor", baseSha, defaultBranch],
      repoDir,
    );
    // Exit 0 — baseSha is an ancestor; the branch fell behind cleanly.
    return {
      status: "rebase",
      reason: `baseSha is an ancestor of ${defaultBranch}; branch needs rebasing`,
      baseSha,
      targetSha,
    };
  } catch {
    // Non-zero exit means either "not an ancestor" (exit 1) or an error.
    // Either way we cannot safely rebase automatically.
    return {
      status: "block",
      reason: `baseSha is not an ancestor of ${defaultBranch}; history may have diverged`,
      baseSha,
      targetSha,
    };
  }
}
