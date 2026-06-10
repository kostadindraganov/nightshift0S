/**
 * bwrap-lite sandbox profile + argv builder (BLUEPRINT §3.12.22, THREAT-MODEL B1).
 *
 * `SandboxProfile` is the single source of truth for what a sandboxed agent is
 * allowed to see. `buildBwrapArgs` turns it into a deterministic bwrap argv.
 * This file is pure — no I/O, no side-effects — so it is fully testable on
 * macOS where bwrap itself is absent. Live namespace isolation is Linux-runtime.
 *
 * INVARIANTS enforced in this builder (verified again by invariants.ts):
 *   - --clearenv before any --setenv  (explicit allowlist only)
 *   - --unshare-{user,pid,ipc,uts,cgroup}  (private namespaces)
 *   - --die-with-parent  (no zombie sandboxes)
 *   - /tmp is a private tmpfs  (no host /tmp leakage)
 *   - ONLY declared paths are bound; /home and host $HOME are NEVER bound
 *   - SSH_AUTH_SOCK is NEVER set
 */

import { homedir } from "node:os";

export interface SandboxProfile {
  /** Absolute path to the git worktree being processed — rw. */
  worktreePath: string;
  /** Absolute path to the per-task agent HOME directory — rw. */
  taskHome: string;
  /** Absolute path to the provider auth dir (credentials, tokens) — ro. */
  providerAuthDir: string;
  /**
   * Env vars that should be visible inside the sandbox.
   * SSH_AUTH_SOCK must NOT appear here — the caller is responsible for
   * scrubbing it before building the profile, but buildBwrapArgs also
   * actively refuses to emit it (defence in depth).
   */
  envAllowlist: Record<string, string>;
  /**
   * Read-only system bind dirs. Defaults to ["/usr","/bin","/lib","/lib64"].
   * Override for minimal images (e.g., drop /lib64 on musl systems).
   */
  roSystemDirs?: string[];
}

const DEFAULT_RO_SYSTEM_DIRS = ["/usr", "/bin", "/lib", "/lib64"] as const;

/**
 * Build the full bwrap argv from a `SandboxProfile`.
 *
 * The returned array does NOT include the "bwrap" executable itself, nor the
 * "--" separator and the command to run — the caller appends those:
 *   `["bwrap", ...buildBwrapArgs(p), "--", ...command]`
 *
 * Never call this if bwrap is unavailable; use spawn.ts which is fail-closed.
 */
export function buildBwrapArgs(p: SandboxProfile): string[] {
  const hostHome = homedir();
  const sysDirs = p.roSystemDirs ?? [...DEFAULT_RO_SYSTEM_DIRS];

  // Sanity guard: refuse to embed /home or host $HOME even if caller sneaks it
  // into roSystemDirs. Enforced again by invariants.ts — belt-and-suspenders.
  const safeSysDirs = sysDirs.filter((d) => {
    if (d === "/home" || d.startsWith("/home/")) return false;
    if (d === hostHome || d.startsWith(`${hostHome}/`)) return false;
    return true;
  });

  const args: string[] = [];

  // ── isolation flags ──────────────────────────────────────────────────────
  args.push("--die-with-parent");
  args.push("--unshare-user");
  args.push("--unshare-pid");
  args.push("--unshare-ipc");
  args.push("--unshare-uts");
  args.push("--unshare-cgroup");

  // ── clean environment (allowlist follows) ─────────────────────────────────
  args.push("--clearenv");

  // ── virtual fs: proc, dev, tmp ───────────────────────────────────────────
  args.push("--proc", "/proc");
  args.push("--dev", "/dev");
  args.push("--tmpfs", "/tmp");

  // ── read-only system dirs ─────────────────────────────────────────────────
  for (const d of safeSysDirs) {
    args.push("--ro-bind", d, d);
  }

  // ── worktree — read-write ─────────────────────────────────────────────────
  args.push("--bind", p.worktreePath, p.worktreePath);

  // ── per-task agent HOME — read-write ──────────────────────────────────────
  args.push("--bind", p.taskHome, p.taskHome);
  args.push("--setenv", "HOME", p.taskHome);

  // ── provider auth dir — read-only ────────────────────────────────────────
  args.push("--ro-bind", p.providerAuthDir, p.providerAuthDir);

  // ── env allowlist ─────────────────────────────────────────────────────────
  // Defence-in-depth: skip SSH_AUTH_SOCK even if caller put it in allowlist.
  for (const [key, val] of Object.entries(p.envAllowlist)) {
    if (key === "SSH_AUTH_SOCK") continue;
    args.push("--setenv", key, val);
  }

  return args;
}
