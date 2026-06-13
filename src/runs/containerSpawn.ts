/**
 * Container-backed spawn selector (BLUEPRINT §V3, item 7.1).
 *
 * Exports `makeIsolatedSpawn`, a factory that returns a drop-in replacement
 * for the internal `sandboxCoderCommand` function in src/runs/spawn.ts.
 *
 * ISOLATION LEVELS (from lowest to highest):
 *   1. bwrap-lite (default): `sandboxCoderCommand` in spawn.ts wraps the inner
 *      command with bwrap namespace flags.
 *   2. container (opt-in): when `containerConfig.enabled`, the inner command is
 *      prefixed with [runtime, "run", "--rm", ..., image] built via
 *      `buildContainerArgv`.  The resulting string[] is handed unchanged to
 *      TmuxLauncher — the container runtime is exec-ed by tmux, NOT by this
 *      module.
 *
 * FAIL-CLOSED CONTRACT:
 *   - When enabled=true on a non-Linux host → ContainerUnavailableError.
 *   - When enabled=true but the runtime binary is absent → ContainerUnavailableError.
 *   - There is NO "warn and fall back to bwrap" path when the container is
 *     explicitly requested — that would silently weaken the operator's declared
 *     isolation policy.
 *   - When enabled=false → delegates to the injected bwrapFallback (production:
 *     the exported `sandboxCoderCommand` from spawn.ts).
 *
 * ARGV SHAPE (container path):
 *   [runtime, "run", "--rm",
 *    "--network", <network>,
 *    "--memory", <memLimit>,
 *    "--cpus", <cpuLimit>,
 *    "-v", "<worktreePath>:<worktreePath>",         // rw
 *    "-v", "<taskHome>:<taskHome>",                 // rw
 *    "-v", "<providerAuthDir>:<providerAuthDir>:ro", // ro
 *    "-w", <worktreePath>,
 *    "-i",                                          // keep stdin open (tmux provides PTY)
 *    [-e KEY=VALUE ...],                            // from profile.envAllowlist only
 *    <image>,
 *    ...innerCommand]
 *
 * ContainerRunner.run() is NOT used here — it is an execFile-based,
 * stdout-capturing API designed for one-shot commands, which is architecturally
 * incompatible with the interactive tmux coder path (long-lived PTY session).
 * Instead, `buildContainerArgv` (pure, deterministic) is called to produce the
 * argv prefix that tmux exec-s.
 *
 * Injectable deps:
 *   - platform: () => string  (production: os.platform)
 *   - runtimeAvailable: checks `which <runtime>` (production: real which)
 *   - bwrapFallback: the bwrap path (production: sandboxCoderCommand from spawn.ts)
 *
 * No side effects at module import. All I/O gated behind factory call.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import {
  buildContainerArgv,
  ContainerUnavailableError,
  type ContainerConfig,
  type ContainerSpec,
} from "../sandbox/container.ts";
import type { SandboxProfile } from "../sandbox/profile.ts";
import type { NightshiftConfig } from "../config/config.ts";

// ---------------------------------------------------------------------------
// Re-export ContainerUnavailableError so callers can catch it without reaching
// into sandbox/container.ts directly.
export { ContainerUnavailableError };

// ---------------------------------------------------------------------------
// Injectable deps interface

export interface IsolatedSpawnDeps {
  /** Injectable platform check — production: () => os.platform() */
  platform?: () => string;
  /**
   * Injectable runtime availability check — production: resolves true iff
   * `which <runtime>` exits 0.
   */
  runtimeAvailable?: (runtime: string) => Promise<boolean>;
  /**
   * Injectable bwrap fallback — used when containerConfig.enabled is false.
   * Production default: the exported `sandboxCoderCommand` from spawn.ts.
   */
  bwrapFallback?: (innerCommand: string[], profile: SandboxProfile) => Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Options

export interface IsolatedSpawnOptions {
  containerConfig: NightshiftConfig["container"];
  deps?: IsolatedSpawnDeps;
}

// ---------------------------------------------------------------------------
// Production helpers (not exported — internal to production defaults)

const execFileAsync = promisify(execFile);

async function defaultRuntimeAvailable(runtime: string): Promise<boolean> {
  try {
    await execFileAsync("which", [runtime], {
      env: { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin" },
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pure helper: build the container argv prefix for the tmux interactive path.
//
// Extends the base buildContainerArgv output with `-i` (keep stdin open) so
// the interactive coder session works correctly inside tmux (tmux provides the
// PTY; the container must keep stdin attached).  The resulting argv is handed
// unchanged to TmuxLauncher.launch().

function buildInteractiveContainerArgv(
  cfg: ContainerConfig,
  spec: ContainerSpec,
): string[] {
  // buildContainerArgv emits:
  //   [runtime, "run", "--rm", --network, --memory, --cpus, -v..., -w, -e..., image, cmd...]
  // We insert "-i" immediately before the image (which is always the second-to-last
  // logical section before cmd).  The cleanest approach: build without the cmd,
  // insert -i before the image, then append cmd.
  const specWithoutCmd: ContainerSpec = { ...spec, cmd: [] };
  const base = buildContainerArgv(cfg, specWithoutCmd);
  // base ends with [image] (cmd is empty so nothing after image).
  // Insert -i before the image token.
  if (base.length === 0) {
    throw new Error("buildContainerArgv returned empty argv (unexpected)");
  }
  const image = base[base.length - 1] as string;
  const prefixWithoutImage = base.slice(0, base.length - 1);
  return [...prefixWithoutImage, "-i", image, ...spec.cmd];
}

// ---------------------------------------------------------------------------
// Factory

/**
 * Returns an async command-wrapper replacing the internal `sandboxCoderCommand`
 * call in src/runs/spawn.ts.
 *
 * When `containerConfig.enabled`:
 *   - Non-Linux or runtime absent → throw ContainerUnavailableError (fail-closed).
 *   - Otherwise → return the container argv prefix + innerCommand (built via
 *     `buildContainerArgv`), ready for TmuxLauncher.
 *
 * When `!containerConfig.enabled`:
 *   - Delegates to the injected `bwrapFallback` (production: the existing
 *     `sandboxCoderCommand` in spawn.ts).
 */
export function makeIsolatedSpawn(
  opts: IsolatedSpawnOptions,
): (innerCommand: string[], profile: SandboxProfile) => Promise<string[]> {
  const { containerConfig, deps = {} } = opts;

  const getPlatform = deps.platform ?? (() => os.platform());
  const checkRuntimeAvailable = deps.runtimeAvailable ?? defaultRuntimeAvailable;
  // Production bwrapFallback is injected by the caller (spawn.ts exports
  // sandboxCoderCommand). When absent and container is disabled, the module
  // throws rather than silently running unsandboxed.
  const bwrapFallback = deps.bwrapFallback;

  return async function isolatedSpawn(
    innerCommand: string[],
    profile: SandboxProfile,
  ): Promise<string[]> {
    if (!containerConfig.enabled) {
      // Container path not requested — delegate to bwrap fallback.
      if (bwrapFallback === undefined) {
        throw new Error(
          "makeIsolatedSpawn: containerConfig.enabled is false but no bwrapFallback was provided. " +
            "Inject bwrapFallback (e.g. sandboxCoderCommand from spawn.ts) or enable container isolation.",
        );
      }
      return bwrapFallback(innerCommand, profile);
    }

    // Container path requested — enforce fail-closed invariants.

    if (getPlatform() !== "linux") {
      throw new ContainerUnavailableError(
        `container isolation requires Linux; refusing on platform "${getPlatform()}" (fail-closed). ` +
          "Disable container.enabled or run on Linux.",
      );
    }

    const available = await checkRuntimeAvailable(containerConfig.runtime);
    if (!available) {
      throw new ContainerUnavailableError(
        `container runtime "${containerConfig.runtime}" not found on PATH (fail-closed). ` +
          "Install docker/podman or disable container.enabled.",
      );
    }

    // Build the ContainerSpec from the SandboxProfile.
    // Mounts:
    //   - worktreePath: rw (the agent writes code here)
    //   - taskHome: rw (per-task HOME; agent writes config, prompt file, etc.)
    //   - providerAuthDir: ro (credentials — same ro guarantee as bwrap path)
    const spec: ContainerSpec = {
      workdir: profile.worktreePath,
      mounts: [
        { source: profile.worktreePath, target: profile.worktreePath, readonly: false },
        { source: profile.taskHome, target: profile.taskHome, readonly: false },
        { source: profile.providerAuthDir, target: profile.providerAuthDir, readonly: true },
      ],
      // Only the explicit allowlist reaches the container — host process.env is
      // NEVER merged (mirrors the bwrap --clearenv + --setenv path).
      env: profile.envAllowlist,
      cmd: innerCommand,
    };

    return buildInteractiveContainerArgv(containerConfig, spec);
  };
}
