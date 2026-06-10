/**
 * Low-level git helpers for the worktree service.
 *
 * Provides execGit (LC_ALL=C, typed GitError) and listWorktrees (porcelain
 * parser). All git calls in the worktree layer go through execGit so that
 * error messages are always English and machine-stable regardless of the
 * user's locale (git's gettext translations would break stderr matching
 * otherwise — see sandcastle issue #595).
 *
 * Ported from sandcastle WorktreeManager (ADR-0003/0004/0007/0018);
 * native plain-Promise reimplementation.
 */

import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class GitError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = "GitError";
    this.stderr = stderr;
  }
}

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/**
 * Runs `git <args>` in `cwd` with LC_ALL=C so stderr is always English.
 * Resolves with trimmed stdout; rejects with a GitError carrying stderr.
 */
export function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new GitError(stderr.trim() || error.message, stderr.trim()));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// worktree list parser
// ---------------------------------------------------------------------------

export interface WorktreeEntry {
  path: string;
  /** null for a detached HEAD (e.g. mid-rebase). */
  branch: string | null;
}

/**
 * Parses `git worktree list --porcelain` output into structured entries.
 * Each stanza starts with "worktree <path>", optionally followed by
 * "branch refs/heads/<name>".
 */
export async function listWorktrees(repoDir: string): Promise<WorktreeEntry[]> {
  const output = await execGit(["worktree", "list", "--porcelain"], repoDir);
  const entries: WorktreeEntry[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (currentPath !== null) {
        entries.push({ path: currentPath, branch: currentBranch });
      }
      currentPath = line.slice("worktree ".length).trim();
      currentBranch = null;
    } else if (line.startsWith("branch ")) {
      // "branch refs/heads/my-branch" -> "my-branch"
      currentBranch = line.slice("branch refs/heads/".length).trim();
    }
  }

  if (currentPath !== null) {
    entries.push({ path: currentPath, branch: currentBranch });
  }

  return entries;
}
