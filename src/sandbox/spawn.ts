/**
 * Fail-closed sandbox spawner (BLUEPRINT §3.12.22, THREAT-MODEL B1 req #1).
 *
 * FAIL-CLOSED CONTRACT: agent spawning is DISABLED unless BOTH conditions hold:
 *   1. `bwrap` is reachable on PATH (absent on macOS — intentional)
 *   2. `checkSandboxInvariants` returns zero violations
 *
 * If either check fails, `spawnSandboxed` throws `SandboxDisabledError` and
 * NO child process is created. There is no "warn and run unsandboxed" path.
 *
 * Callers combine the returned Subprocess with the normal Bun API: await the
 * exit code via `proc.exited`, write stdin, etc.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildBwrapArgs } from "./profile.ts";
import { checkSandboxInvariants } from "./invariants.ts";
import type { SandboxProfile } from "./profile.ts";

const execFileAsync = promisify(execFile);

// ── Error type ────────────────────────────────────────────────────────────────

export class SandboxDisabledError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Sandbox unavailable — agent spawn blocked. Reason: ${reason}`);
    this.name = "SandboxDisabledError";
    this.reason = reason;
  }
}

// ── bwrap availability ────────────────────────────────────────────────────────

/**
 * Returns true iff `bwrap` exists and is executable on the current PATH.
 * Uses `which` (POSIX). On macOS or systems without bwrap, returns false.
 * Result is NOT cached — the caller (spawnSandboxed) decides caching policy.
 */
export async function bwrapAvailable(): Promise<boolean> {
  try {
    await execFileAsync("which", ["bwrap"], {
      env: { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin" },
    });
    return true;
  } catch {
    return false;
  }
}

// ── fail-closed spawner ───────────────────────────────────────────────────────

/**
 * Spawn `command` inside a bwrap sandbox described by `profile`.
 *
 * Steps:
 *   1. Build bwrap argv from profile.
 *   2. Run invariant checker — any violation → throw SandboxDisabledError.
 *   3. Check bwrap availability — absent → throw SandboxDisabledError.
 *   4. (All green) Bun.spawn(["bwrap", ...args, "--", ...command]).
 *
 * Throws `SandboxDisabledError` — never swallows it.
 */
export async function spawnSandboxed(
  p: SandboxProfile,
  command: string[]
): Promise<import("bun").Subprocess> {
  // Step 1: build argv
  const sandboxArgs = buildBwrapArgs(p);

  // Step 2: invariant check (pure, synchronous)
  const violations = checkSandboxInvariants(sandboxArgs, p);
  if (violations.length > 0) {
    const summary = violations
      .map((v) => `[${v.rule}] ${v.detail}`)
      .join("; ");
    throw new SandboxDisabledError(`invariant violations: ${summary}`);
  }

  // Step 3: bwrap availability (async, may block on PATH scan)
  const available = await bwrapAvailable();
  if (!available) {
    throw new SandboxDisabledError(
      "bwrap not found on PATH (Linux-only; running on macOS or bwrap not installed)"
    );
  }

  // Step 4: all checks passed — spawn
  return Bun.spawn(["bwrap", ...sandboxArgs, "--", ...command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}
