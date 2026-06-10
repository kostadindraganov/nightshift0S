/**
 * Per-worktree file lock (ADR-0007).
 *
 * Atomic O_EXCL lock files with PID stale-detection. Fail-fast on contention
 * — NEVER wait or retry if the holder is alive. Two concurrent runs on one
 * branch would clobber each other's uncommitted work, so blocking would be
 * worse than failing quickly.
 *
 * Lock file format: plain decimal PID string written after creation so that
 * PID is available for stale checks on the next acquisition attempt.
 *
 * Ported from sandcastle WorktreeManager (ADR-0003/0004/0007/0018);
 * native plain-Promise reimplementation.
 */

import {
  openSync,
  writeSync,
  unlinkSync,
  readFileSync,
  mkdirSync,
  closeSync,
} from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class WorktreeLockError extends Error {
  readonly lockPath: string;
  readonly holderPid: number | null;
  constructor(lockPath: string, holderPid: number | null) {
    const who =
      holderPid !== null ? `held by PID ${holderPid}` : "held by unknown PID";
    super(
      `Worktree lock contention: ${lockPath} is already ${who}. ` +
        `Another operation is in progress on this branch. ` +
        `Wait for it to complete and retry.`,
    );
    this.name = "WorktreeLockError";
    this.lockPath = lockPath;
    this.holderPid = holderPid;
  }
}

// ---------------------------------------------------------------------------
// PID liveness check
// ---------------------------------------------------------------------------

/**
 * Returns true if the process with `pid` is alive.
 * Uses kill(pid, 0) — does NOT send a signal; just checks if the process
 * exists and we have permission to signal it.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lock implementation
// ---------------------------------------------------------------------------

/**
 * Reads the PID stored in the lock file. Returns null on any parse failure.
 */
function readLockPid(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Creates the lock file atomically via O_EXCL, then writes our PID into it.
 * Returns the fd on success, throws on EEXIST (already locked).
 */
function createLockFile(lockPath: string): number {
  // Ensure lock dir exists
  mkdirSync(dirname(lockPath), { recursive: true });
  // O_WRONLY | O_CREAT | O_EXCL = "wx" in node fs
  const fd = openSync(lockPath, "wx");
  writeSync(fd, String(process.pid));
  closeSync(fd);
  return fd;
}

/**
 * Acquires a worktree file lock.
 *
 * - On EEXIST: reads the stored PID.
 *   - Dead PID  → remove stale lock + retry once.
 *   - Alive PID → throw WorktreeLockError immediately (fail-fast, ADR-0007).
 * - Returns `{ release }` where release() unlinks the lock file.
 */
export async function acquireLock(
  lockPath: string,
): Promise<{ release: () => void }> {
  const tryAcquire = (isRetry: boolean): void => {
    try {
      createLockFile(lockPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        const holderPid = readLockPid(lockPath);
        const alive = holderPid !== null && isPidAlive(holderPid);
        if (!alive && !isRetry) {
          // Stale lock — remove and retry exactly once
          try {
            unlinkSync(lockPath);
          } catch {
            // Already gone — that is fine
          }
          return tryAcquire(true);
        }
        // Alive holder or retry already done — fail fast
        throw new WorktreeLockError(lockPath, holderPid);
      }
      throw err;
    }
  };

  tryAcquire(false);

  const release = (): void => {
    try {
      unlinkSync(lockPath);
    } catch {
      // Best-effort; if already gone that is fine
    }
  };

  return { release };
}
