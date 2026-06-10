/**
 * Worktree service — creates, reuses, removes, and prunes git worktrees.
 *
 * Implements the correctness properties from BLUEPRINT §3.6 and sandcastle
 * ADRs 0003, 0004, 0007, 0018:
 *
 *  - ADR-0007: atomic per-worktree file lock, fail-fast on contention.
 *  - ADR-0018: crypto-random 6-char hex suffix on generated branch names so
 *    parallel fan-out within the same second doesn't collide.
 *  - NO_CONFIG_LOCK_FLAGS: every `git worktree add` gets
 *    -c branch.autoSetupMerge=false -c push.autoSetupRemote=false to avoid
 *    .git/config.lock races under concurrent operations.
 *  - ADR-0003: managed-worktree reuse: clean+behind-origin → ff-only from
 *    origin; dirty/diverged/no-remote → reuse as-is (never reset --hard).
 *    Collision with main tree or external worktree → throw.
 *  - ADR-0004: no auto-teardown on failure — the worktree is the recovery
 *    surface; removal is always explicit.
 *
 * Ported from sandcastle WorktreeManager (ADR-0003/0004/0007/0018);
 * native plain-Promise reimplementation.
 */

import { randomBytes } from "node:crypto";
import { join, normalize } from "node:path";
import {
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { execGit, listWorktrees } from "./git.ts";
import type { WorktreeEntry } from "./git.ts";
import { acquireLock } from "./lock.ts";

// ---------------------------------------------------------------------------
// Re-export error types so callers only need to import from "worktree.ts"
// ---------------------------------------------------------------------------

export { WorktreeLockError } from "./lock.ts";
export { GitError } from "./git.ts";

// ---------------------------------------------------------------------------
// Worktree-level typed error
// ---------------------------------------------------------------------------

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Prevents `git worktree add -b` from writing upstream tracking config to
 * `.git/config`, avoiding config.lock races with concurrent processes.
 */
const NO_CONFIG_LOCK_FLAGS = [
  "-c",
  "branch.autoSetupMerge=false",
  "-c",
  "push.autoSetupRemote=false",
];

// ---------------------------------------------------------------------------
// Name utilities
// ---------------------------------------------------------------------------

/** Lowercase and replace all non-alphanumeric characters with "-". */
export function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "-");
}

/**
 * Generates a unique branch name for a task.
 * Format: `ns/<taskId>-<slug>-<rand6>` where rand6 is 3 random bytes as hex.
 *
 * The random suffix prevents collisions between concurrent calls within the
 * same wall-clock second (ADR-0018).
 */
export function generateBranchName(opts?: {
  taskId?: number;
  slug?: string;
}): string {
  const suffix = randomBytes(3).toString("hex");
  const parts: string[] = [];
  if (opts?.taskId !== undefined) parts.push(String(opts.taskId));
  if (opts?.slug) parts.push(sanitizeName(opts.slug));
  parts.push(suffix);
  return `ns/${parts.join("-")}`;
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

/** Normalize separators to forward slashes for cross-platform comparisons. */
function normalizeSep(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Finds an existing worktree that collides with the given `branch` or
 * `worktreePath`. Matches by branch first, then falls back to a normalized
 * path comparison (covers mid-rebase detached-HEAD state).
 */
export function findCollidingWorktree(
  existing: readonly WorktreeEntry[],
  branch: string,
  worktreePath: string,
): WorktreeEntry | undefined {
  return (
    existing.find((wt) => wt.branch === branch) ??
    existing.find(
      (wt) => normalizeSep(wt.path) === normalizeSep(worktreePath),
    )
  );
}

/**
 * Whether `worktreePath` lives under `worktreesDir` (i.e. is managed by
 * nightshift rather than the main working tree or an external worktree).
 */
export function isManagedWorktreePath(
  worktreePath: string,
  worktreesDir: string,
): boolean {
  return normalizeSep(worktreePath).startsWith(normalizeSep(worktreesDir));
}

// ---------------------------------------------------------------------------
// Worktree path derivation
// ---------------------------------------------------------------------------

function worktreesDir(repoDir: string): string {
  return join(repoDir, ".nightshift", "worktrees");
}

function locksDir(repoDir: string): string {
  return join(repoDir, ".nightshift", "locks");
}

function worktreePathForBranch(repoDir: string, branch: string): string {
  // Replace "/" with "-" so branch "ns/123-foo-abc123" → dir "ns-123-foo-abc123"
  const dirName = branch.replace(/\//g, "-");
  return join(worktreesDir(repoDir), dirName);
}

function lockPathForBranch(repoDir: string, branch: string): string {
  const sanitized = sanitizeName(branch);
  return join(locksDir(repoDir), `${sanitized}.lock`);
}

// ---------------------------------------------------------------------------
// Fast-forward from origin (ADR-0003, non-fatal)
// ---------------------------------------------------------------------------

/**
 * Attempts to fast-forward the worktree from origin/<branch>.
 * All failures are silently logged and treated as "reuse as-is" — per ADR-0003
 * the worst outcome is a stale-but-usable worktree, which is fine.
 */
async function fastForwardFromOrigin(
  worktreePath: string,
  branch: string,
): Promise<void> {
  // If HEAD is detached (mid-rebase), skip to avoid breaking git rebase --continue
  let headRef = "";
  try {
    headRef = (
      await execGit(["symbolic-ref", "--quiet", "HEAD"], worktreePath)
    ).trim();
  } catch {
    headRef = "";
  }

  if (headRef !== `refs/heads/${branch}`) {
    console.log(
      `Reusing worktree at ${worktreePath} (branch '${branch}') — ` +
        `HEAD is not on '${branch}', skipping origin refresh`,
    );
    return;
  }

  // Attempt fetch — non-fatal
  try {
    await execGit(
      [...NO_CONFIG_LOCK_FLAGS, "fetch", "origin", branch],
      worktreePath,
    );
  } catch {
    console.log(
      `Could not fetch from origin ` +
        `(reusing worktree at ${worktreePath} as-is, branch '${branch}')`,
    );
    return;
  }

  // Attempt ff-only merge — non-fatal
  let before = "";
  let after = "";
  try {
    before = (await execGit(["rev-parse", "HEAD"], worktreePath)).trim();
  } catch {
    // ok
  }

  try {
    await execGit(
      [...NO_CONFIG_LOCK_FLAGS, "merge", "--ff-only", `origin/${branch}`],
      worktreePath,
    );
  } catch {
    console.log(
      `Branch '${branch}' has diverged from origin ` +
        `(reusing worktree at ${worktreePath} as-is)`,
    );
    return;
  }

  try {
    after = (await execGit(["rev-parse", "HEAD"], worktreePath)).trim();
  } catch {
    // ok
  }

  if (before && after && before !== after) {
    console.log(
      `Fast-forwarded worktree at ${worktreePath} (branch '${branch}') to origin/${branch}`,
    );
  } else {
    console.log(
      `Reusing existing worktree at ${worktreePath} (branch '${branch}')`,
    );
  }
}

// ---------------------------------------------------------------------------
// Has uncommitted changes check
// ---------------------------------------------------------------------------

async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const output = await execGit(["status", "--porcelain"], worktreePath);
  return output.trim().length > 0;
}

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

export interface CreateWorktreeOpts {
  repoDir: string;
  taskId?: number;
  slug?: string;
  /** Explicit branch name. If omitted, generateBranchName is used. */
  branch?: string;
  /** Base branch / commit for new branch creation. Defaults to HEAD. */
  baseBranch?: string;
}

export interface CreateWorktreeResult {
  path: string;
  branch: string;
  reused: boolean;
}

/**
 * Creates (or reuses) a git worktree for a task.
 *
 * Locking (ADR-0007): acquires a per-branch file lock before any git work.
 * Contention → immediate WorktreeLockError (no wait).
 *
 * Collision handling (ADR-0003):
 *  - Managed worktree (under .nightshift/worktrees/):
 *    - Clean → fast-forward from origin, return reused:true.
 *    - Dirty  → reuse as-is (uncommitted work preserved), return reused:true.
 *  - Main working tree or external worktree → throw WorktreeError.
 *
 * New worktree:
 *  - If the branch ref already exists:   `git worktree add <path> <branch>`.
 *  - If the branch ref does not exist:   `git worktree add -b <branch> <path> <base>`.
 *  - Always uses NO_CONFIG_LOCK_FLAGS.
 *
 * ADR-0004: never auto-teardown on failure — the lock is released, the
 * partially-created worktree (if any) is left for manual recovery.
 */
export async function createWorktree(
  opts: CreateWorktreeOpts,
): Promise<CreateWorktreeResult> {
  // Resolve repoDir to its canonical path so our computed paths match what
  // git reports in `worktree list --porcelain` (git uses realpath internally;
  // on macOS /var is a symlink to /private/var).
  let repoDir: string;
  try {
    repoDir = realpathSync(opts.repoDir);
  } catch {
    repoDir = opts.repoDir;
  }
  const branch =
    opts.branch ?? generateBranchName({ taskId: opts.taskId, slug: opts.slug });
  const worktreePath = worktreePathForBranch(repoDir, branch);
  const lockPath = lockPathForBranch(repoDir, branch);

  // Ensure dirs exist
  mkdirSync(worktreesDir(repoDir), { recursive: true });
  mkdirSync(locksDir(repoDir), { recursive: true });

  // ADR-0007: atomic lock, fail-fast on contention
  const lock = await acquireLock(lockPath);
  try {
    // List existing worktrees to detect collisions
    const existing = await listWorktrees(repoDir);
    const collision = findCollidingWorktree(existing, branch, worktreePath);

    if (collision) {
      const wtsDir = worktreesDir(repoDir);
      if (isManagedWorktreePath(collision.path, wtsDir)) {
        // ADR-0003 reuse path
        const dirty = await hasUncommittedChanges(collision.path);
        if (dirty) {
          console.warn(
            `Reusing worktree at ${collision.path} (branch '${branch}') ` +
              `— worktree has uncommitted changes`,
          );
        } else {
          await fastForwardFromOrigin(collision.path, branch);
        }
        return { path: normalize(collision.path), branch, reused: true };
      }
      // Main working tree or external worktree — always throw
      throw new WorktreeError(
        `Branch '${branch}' is already checked out in worktree at '${collision.path}'. ` +
          `Use a different branch name, or wait for the other run to finish.`,
      );
    }

    // No collision — create a new worktree
    // First try: existing branch ref
    let created = false;
    try {
      await execGit(
        [...NO_CONFIG_LOCK_FLAGS, "worktree", "add", worktreePath, branch],
        repoDir,
      );
      created = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("invalid reference") && !msg.includes("not a commit")) {
        throw err;
      }
      // Branch ref doesn't exist — create it
    }

    if (!created) {
      await execGit(
        [
          ...NO_CONFIG_LOCK_FLAGS,
          "worktree",
          "add",
          "-b",
          branch,
          worktreePath,
          opts.baseBranch ?? "HEAD",
        ],
        repoDir,
      );
    }

    return { path: worktreePath, branch, reused: false };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

/**
 * Removes a worktree and its git metadata (explicit removal only — ADR-0004).
 * Derives the repo dir from the worktree path:
 *   <repoDir>/.nightshift/worktrees/<name> → up three levels.
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  // path is <repoDir>/.nightshift/worktrees/<name>
  const repoDir = join(worktreePath, "..", "..", "..");
  let resolvedRepo: string;
  try {
    resolvedRepo = realpathSync(normalize(repoDir));
  } catch {
    resolvedRepo = normalize(repoDir);
  }
  await execGit(["worktree", "remove", "--force", worktreePath], resolvedRepo);
}

// ---------------------------------------------------------------------------
// pruneStale
// ---------------------------------------------------------------------------

/**
 * Prunes stale git worktree metadata and removes orphaned directories under
 * `.nightshift/worktrees/` that git no longer knows about.
 *
 * Active worktrees are preserved. `git worktree prune` runs first so git
 * metadata for gone directories is cleaned up before we check for orphans.
 */
export async function pruneStale(repoDir: string): Promise<void> {
  // Canonicalize so our join paths match git's realpath-based output
  let resolvedRepo: string;
  try {
    resolvedRepo = realpathSync(repoDir);
  } catch {
    resolvedRepo = repoDir;
  }

  // Let git remove metadata for worktrees whose directories are gone
  await execGit(["worktree", "prune"], resolvedRepo);

  const wtsDir = worktreesDir(resolvedRepo);
  if (!existsSync(wtsDir)) return;

  // Collect active worktree paths from git
  const entries = await listWorktrees(resolvedRepo);
  const activePaths = new Set(entries.map((e) => normalizeSep(e.path)));

  // Walk the managed worktrees dir and remove orphans
  let subdirs: string[];
  try {
    subdirs = readdirSync(wtsDir);
  } catch {
    return;
  }

  for (const name of subdirs) {
    const entryPath = join(wtsDir, name);
    let isDir = false;
    try {
      isDir = statSync(entryPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    if (!activePaths.has(normalizeSep(entryPath))) {
      // Orphan — not in git's active set; remove it
      try {
        rmSync(entryPath, { recursive: true, force: true });
      } catch (err) {
        console.error(`pruneStale: failed to remove ${entryPath}:`, err);
      }
    }
  }
}
