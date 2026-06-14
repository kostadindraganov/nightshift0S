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
   * Optional: host-side source for the auth dir. When set, the bwrap bind is
   * `--ro-bind hostAuthSource providerAuthDir`, allowing creds outside /home to
   * be mounted at the right in-sandbox path without violating R2:home-leak.
   */
  hostAuthSource?: string;
  /**
   * Optional: absolute path to the main repo's .git directory. Required for git
   * operations to work inside the sandbox when the worktree is a linked worktree
   * (i.e. worktree/.git is a file pointing back to repoRoot/.git/worktrees/<id>).
   * Without this bind git cannot resolve the gitdir pointer and all git commands fail.
   */
  repoGitDir?: string;
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
  /**
   * Optional: the uid the agent process should run as INSIDE the new user
   * namespace bwrap creates. When set, buildBwrapArgs emits `--uid <agentUid>`.
   * This is what makes nftables egress enforceable: the egress rules match
   * `meta skuid <uid>` (src/egress/allowlist.ts), so agents must run under the
   * dedicated agent uid for packets to be filtered rather than passed unfiltered.
   * When unset, behaviour is exactly as before (no --uid; agent inherits the
   * launcher uid). bwrap's --uid only works within the user namespace it already
   * unshares, so this is Linux-runtime; the argv shape is asserted in tests.
   */
  agentUid?: number;
  /**
   * Optional: the gid the agent process should run as inside the namespace.
   * Only emitted (`--gid <agentGid>`) when set. Independent of agentUid.
   */
  agentGid?: number;
}

const DEFAULT_RO_SYSTEM_DIRS = ["/usr", "/bin", "/lib", "/lib64"] as const;

/** Files/dirs needed for DNS resolution and TLS inside the sandbox. */
const NETWORK_RO_BINDS = [
  "/etc/resolv.conf",
  "/etc/ssl",
  "/etc/nsswitch.conf",
] as const;

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

  // ── run as the dedicated agent uid/gid (egress enforcement) ────────────────
  // Optional & fail-open-to-prior-behaviour: only emit --uid/--gid when the
  // caller set them. These take effect inside the user namespace unshared above
  // and make `meta skuid <uid>` nftables egress rules actually match the agent.
  if (p.agentUid !== undefined) {
    args.push("--uid", String(p.agentUid));
  }
  if (p.agentGid !== undefined) {
    args.push("--gid", String(p.agentGid));
  }

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

  // ── DNS + TLS (needed for API calls, e.g. api.anthropic.com) ─────────────
  for (const f of NETWORK_RO_BINDS) {
    args.push("--ro-bind", f, f);
  }

  // ── worktree — read-write ─────────────────────────────────────────────────
  args.push("--bind", p.worktreePath, p.worktreePath);

  // ── main repo .git dir — read-write ──────────────────────────────────────
  // Linked worktrees have a .git FILE (not dir) pointing to repoRoot/.git/worktrees/<id>.
  // Without this bind, git inside the sandbox cannot resolve the gitdir pointer
  // and every git command fails. Rw so git can write COMMIT_EDITMSG, update-index, etc.
  if (p.repoGitDir) {
    args.push("--bind", p.repoGitDir, p.repoGitDir);
  }

  // ── per-task agent HOME — read-write ──────────────────────────────────────
  args.push("--bind", p.taskHome, p.taskHome);
  args.push("--setenv", "HOME", p.taskHome);

  // ── provider auth dir ────────────────────────────────────────────────────
  // Three cases:
  //  A) External source (hostAuthSource set, different path): ro-bind the
  //     external dir at providerAuthDir inside the sandbox.
  //  B) providerAuthDir is NOT under taskHome: ro-bind it at itself so the
  //     path is accessible inside the sandbox (otherwise bwrap won't see it).
  //  C) providerAuthDir IS under taskHome: the rw taskHome bind above already
  //     covers it — adding --ro-bind here would make it read-only and block
  //     claude session writes (e.g. history, settings, session-env).
  const underTaskHome =
    p.providerAuthDir.startsWith(p.taskHome + "/") ||
    p.providerAuthDir === p.taskHome;
  if (p.hostAuthSource && p.hostAuthSource !== p.providerAuthDir) {
    args.push("--ro-bind", p.hostAuthSource, p.providerAuthDir); // case A
  } else if (!underTaskHome) {
    args.push("--ro-bind", p.providerAuthDir, p.providerAuthDir); // case B
  }
  // case C: no extra bind — rw taskHome access is sufficient

  // ── env allowlist ─────────────────────────────────────────────────────────
  // Defence-in-depth: skip SSH_AUTH_SOCK even if caller put it in allowlist.
  for (const [key, val] of Object.entries(p.envAllowlist)) {
    if (key === "SSH_AUTH_SOCK") continue;
    args.push("--setenv", key, val);
  }

  return args;
}
