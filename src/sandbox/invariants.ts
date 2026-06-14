/**
 * Sandbox invariant checker (BLUEPRINT §3.12.22, THREAT-MODEL B1).
 *
 * `checkSandboxInvariants` walks the built bwrap argv and asserts every
 * required security property. It returns an array of `Violation` objects —
 * an empty array means the argv is clean. The spawner (spawn.ts) treats any
 * non-empty result as a hard failure: the process is NEVER started.
 *
 * Checked invariants:
 *   R1  --clearenv must be present
 *   R2  No --bind / --ro-bind whose source starts with /home or host homedir()
 *   R3  No --setenv SSH_AUTH_SOCK
 *   R4  Every --bind / --ro-bind source must be a declared path (worktree,
 *       taskHome, providerAuthDir, system dirs, or a virtual mount)
 *   R5  --unshare-{user,pid,ipc,uts,cgroup} must all be present
 *
 * This file is pure — no I/O — and runs on macOS for CI purposes.
 */

import { homedir } from "node:os";
import type { SandboxProfile } from "./profile.ts";

export interface Violation {
  rule: string;
  detail: string;
}

/** Virtual mounts that bwrap owns (not real host paths). */
const VIRTUAL_TARGETS = new Set(["/proc", "/dev", "/tmp"]);

const DEFAULT_RO_SYSTEM_DIRS = ["/usr", "/bin", "/lib", "/lib64"];

const REQUIRED_UNSHARE_FLAGS = [
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--unshare-cgroup",
] as const;

/**
 * Collect all (flag, src, dst) bind entries from an argv array.
 * Handles: --bind src dst, --ro-bind src dst, --proc dst, --dev dst,
 * --tmpfs dst (single-arg virtual mounts stored with src="<virtual>").
 */
function collectBinds(
  args: string[]
): Array<{ flag: string; src: string; dst: string }> {
  const result: Array<{ flag: string; src: string; dst: string }> = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--bind" || a === "--ro-bind") {
      const src = args[i + 1] ?? "";
      const dst = args[i + 2] ?? "";
      result.push({ flag: a, src, dst });
      i += 2;
    } else if (a === "--proc" || a === "--dev" || a === "--tmpfs") {
      const dst = args[i + 1] ?? "";
      result.push({ flag: a, src: "<virtual>", dst });
      i += 1;
    }
  }
  return result;
}

/**
 * Collect all --setenv entries from argv as {key, value} pairs.
 */
function collectSetenvs(
  args: string[]
): Array<{ key: string; value: string }> {
  const result: Array<{ key: string; value: string }> = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--setenv") {
      const key = args[i + 1] ?? "";
      const value = args[i + 2] ?? "";
      result.push({ key, value });
      i += 2;
    }
  }
  return result;
}

/**
 * Returns true if `path` is under a forbidden root (/home or host homedir).
 */
function isForbiddenPath(path: string): boolean {
  const host = homedir();
  if (path === "/home" || path.startsWith("/home/")) return true;
  if (path === host || path.startsWith(`${host}/`)) return true;
  return false;
}

/**
 * Check all sandbox invariants against the built bwrap argv + the profile
 * that was used to build it. Returns [] when all invariants hold.
 */
export function checkSandboxInvariants(
  args: string[],
  p: SandboxProfile
): Violation[] {
  const violations: Violation[] = [];
  const sysDirs = p.roSystemDirs ?? DEFAULT_RO_SYSTEM_DIRS;

  // R1 — --clearenv must be present
  if (!args.includes("--clearenv")) {
    violations.push({
      rule: "R1:clearenv",
      detail: "--clearenv is absent; environment is not sanitized",
    });
  }

  // R5 — all --unshare-* flags must be present
  for (const flag of REQUIRED_UNSHARE_FLAGS) {
    if (!args.includes(flag)) {
      violations.push({
        rule: "R5:unshare",
        detail: `Required namespace flag ${flag} is absent`,
      });
    }
  }

  // R3 — no SSH_AUTH_SOCK in --setenv
  const setenvs = collectSetenvs(args);
  for (const { key } of setenvs) {
    if (key === "SSH_AUTH_SOCK") {
      violations.push({
        rule: "R3:ssh-agent",
        detail: "--setenv SSH_AUTH_SOCK is present; SSH agent must not leak into sandbox",
      });
    }
  }

  // R2 + R4 — inspect every bind
  const declared = new Set<string>([
    p.worktreePath,
    p.taskHome,
    p.providerAuthDir,
    // hostAuthSource is the on-host source path when it differs from providerAuthDir
    // (e.g. /opt/nightshift/.claude). It must NOT be under /home (R2 still applies).
    ...(p.hostAuthSource ? [p.hostAuthSource] : []),
    // repoGitDir: main repo .git dir needed for git worktree operations inside sandbox.
    ...(p.repoGitDir ? [p.repoGitDir] : []),
    ...sysDirs,
    // DNS + TLS files for network connectivity (api.anthropic.com etc.)
    "/etc/resolv.conf",
    "/etc/ssl",
    "/etc/nsswitch.conf",
  ]);

  const binds = collectBinds(args);
  for (const { flag, src } of binds) {
    if (src === "<virtual>") continue; // --proc / --dev / --tmpfs — always ok

    // R2: no /home or host $HOME
    if (isForbiddenPath(src)) {
      violations.push({
        rule: "R2:home-leak",
        detail: `${flag} with source "${src}" exposes /home or host homedir inside sandbox`,
      });
    }

    // R4: every real bind source must be declared in the profile
    if (!isDeclaredPath(src, declared)) {
      violations.push({
        rule: "R4:undeclared-bind",
        detail: `${flag} with source "${src}" is not declared in SandboxProfile`,
      });
    }
  }

  return violations;
}

/**
 * True if `src` exactly matches or is a child of one of the declared paths.
 */
function isDeclaredPath(src: string, declared: Set<string>): boolean {
  for (const d of declared) {
    if (src === d || src.startsWith(`${d}/`)) return true;
  }
  return false;
}
