/**
 * Agent invocation builder + run spawn orchestration (task 2.5).
 *
 * `buildAgentInvocation` implements the PROMPT-VIA-FILE trick (§3.7.3):
 *   - The prompt is written to a temp file inside homePath.
 *   - The command is a shell one-liner: `p=$(cat <file>); rm <file>; exec <cli> "$p"`.
 *   - This dodges the 16 KB tmux paste limit and keeps the prompt off argv/ps.
 *
 * `spawnRun` orchestrates a full run start:
 *   1. Create the git worktree (via ../worktree/worktree.ts).
 *   2. Ensure the per-task HOME directory exists (homeRoot/<taskId>).
 *   3. Build the agent invocation.
 *   4. Launch via the injected Launcher.
 *   5. Transition queued→starting, recording tmuxSession/worktreePath/homePath.
 */

import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { RunRow } from "../db/schema.ts";
import { createWorktree } from "../worktree/worktree.ts";
import { mountSkills, appendSkillsFooter } from "./skills.ts";
import { transitionRun } from "./transitions.ts";
import type { Launcher, LaunchHandle } from "./launcher.ts";
import { buildBwrapArgs, type SandboxProfile } from "../sandbox/profile.ts";
import { checkSandboxInvariants } from "../sandbox/invariants.ts";
import { bwrapAvailable, SandboxDisabledError } from "../sandbox/spawn.ts";
import { makeIsolatedSpawn } from "./containerSpawn.ts";
import type { NightshiftConfig } from "../config/config.ts";

// ---------------------------------------------------------------------------
// buildAgentInvocation

/** Provider CLI executable name by driver name. */
const PROVIDER_CLI: Record<string, string> = {
	"claude-code": "claude",
	claudeCode: "claude",
	codex: "codex",
};

export interface BuildAgentInvocationInput {
	provider: string;
	prompt: string;
	worktreePath: string;
	homePath: string;
	runId: number;
	/** Base URL for the hook bridge (sets NIGHTSHIFT_PORT env var). */
	apiBaseUrl?: string;
	bearer?: string;
	/**
	 * When set, resume an existing provider session instead of starting fresh:
	 * the one-liner `exec`s the CLI with `--resume '<id>'` (LIVE-WIRING D2).
	 * Applies to claude and codex alike (the prompt becomes the next turn).
	 */
	resumeSessionId?: string;
}

export interface AgentInvocation {
	command: string[];
	env: Record<string, string>;
}

/**
 * Resolve the provider CLI binary name from the driver name, with a safe
 * fallback: unknown drivers use the driver name as-is so callers can pass
 * arbitrary local paths in tests.
 */
function resolveProviderCli(provider: string): string {
	return PROVIDER_CLI[provider] ?? provider;
}

/**
 * Build the command and environment for launching a provider CLI run.
 *
 * PROMPT-VIA-FILE (§3.7.3):
 *   The prompt is written to `<homePath>/.ns-prompt-<runId>` before launch.
 *   The command reads+deletes the file with `cat`+`rm`, then `exec`s the
 *   provider CLI — so the prompt never appears in argv or `ps` output, and
 *   the tmux 16 KB paste ceiling is not a concern.
 */
export function buildAgentInvocation(input: BuildAgentInvocationInput): AgentInvocation {
	const { provider, prompt, worktreePath, homePath, runId, apiBaseUrl, bearer, resumeSessionId } =
		input;
	const cli = resolveProviderCli(provider);

	// Write the prompt to a temp file inside homePath.  The file is deleted by
	// the shell one-liner before the CLI starts, so it never persists past launch.
	const promptFile = join(homePath, `.ns-prompt-${runId}`);
	writeFileSync(promptFile, prompt, { encoding: "utf8", mode: 0o600 });

	// `--resume '<id>'` when resuming a captured session id (LIVE-WIRING D2).
	// Single-quote with the same `'\''` escaping TmuxLauncher uses for tokens.
	const resumeFlag =
		resumeSessionId !== undefined
			? `--resume '${resumeSessionId.replace(/'/g, "'\\''")}' `
			: "";

	// Provider-specific extra flags: claude gets --dangerously-skip-permissions
	// so it doesn't halt for each file/shell operation inside the bwrap sandbox
	// (the operator already approved autonomous operation by enabling nightshift).
	const extraFlags = (provider === "claude-code" || provider === "claudeCode")
		? "--dangerously-skip-permissions "
		: "";

	// Shell one-liner: read the file into $p, delete it, exec the CLI with $p.
	const shellOneLiner = `p=$(cat '${promptFile}'); rm -f '${promptFile}'; exec ${cli} ${extraFlags}${resumeFlag}"$p"`;

	const command = ["sh", "-c", shellOneLiner];

	const env: Record<string, string> = {
		// Isolate the agent's HOME to the per-task directory.
		HOME: homePath,
		// Tell the hook bridge which run this process belongs to.
		NIGHTSHIFT_RUN_ID: String(runId),
		// Working directory for the agent (the worktree).
		NIGHTSHIFT_WORKTREE: worktreePath,
		// Minimal PATH — enough for the provider CLI. Prepend NIGHTSHIFT_PROVIDER_BIN_DIR
		// so CLIs installed outside /home (e.g. /opt/nightshift/bin) are found first.
		PATH: [
			process.env.NIGHTSHIFT_PROVIDER_BIN_DIR,
			"/usr/local/bin",
			"/usr/bin",
			"/bin",
		].filter(Boolean).join(":"),
		// Locale normalisation — avoid locale-dependent CLI output.
		LC_ALL: "C",
		LANG: "en_US.UTF-8",
		// Signal to the provider CLI that it runs inside an automated sandbox.
		IS_SANDBOX: "1",
	};

	// Inject hook-bridge credentials into the sandbox env so hook.sh can POST
	// lifecycle events back to the server. Fall back to the service process env
	// when the caller doesn't explicitly pass these values.
	const resolvedToken = bearer ?? process.env.NIGHTSHIFT_API_TOKEN;
	if (resolvedToken) env.NIGHTSHIFT_API_TOKEN = resolvedToken;

	if (apiBaseUrl !== undefined) {
		// Extract the port from the base URL so the hook bridge can use it.
		try {
			const url = new URL(apiBaseUrl);
			if (url.port) env.NIGHTSHIFT_PORT = url.port;
		} catch {
			// Ignore malformed URLs; the hook bridge will use its default port.
		}
	} else {
		// Fall back to the service's configured port.
		env.NIGHTSHIFT_PORT = process.env.NIGHTSHIFT_PORT ?? "3000";
	}

	return { command, env };
}

// ---------------------------------------------------------------------------
// Coder sandbox (BLUEPRINT §3.12.22, THREAT-MODEL B1)
//
// The interactive coder is the primary, prompt-injectable, arbitrary-shell
// agent. It MUST run inside the bwrap-lite sandbox — not just the one-shot
// reviewer/planner. These builders are pure so the wrapped argv is unit-
// testable on macOS; the fail-closed availability check lives in spawnRun.

/** Provider credential dir under the per-task HOME (ro-bound in the sandbox). */
function providerAuthDir(homePath: string, provider: string): string {
	return provider === "codex" ? join(homePath, ".codex") : join(homePath, ".claude");
}

/**
 * Resolve the dedicated agent uid/gid from the environment.
 * NIGHTSHIFT_AGENT_UID / NIGHTSHIFT_AGENT_GID, parsed as non-negative integers.
 * Unset / blank / non-numeric ⇒ undefined (no --uid/--gid emitted; behaviour is
 * exactly as before). This is the single place the env is read for the coder and
 * one-shot sandbox profiles so agents run under the uid the nftables egress rules
 * (`meta skuid <uid>`) match. The sane fallback (e.g. 999) is supplied by the
 * top-level entrypoint, NOT here — profile.ts and this builder stay pure-by-env.
 */
export function resolveAgentIds(env: NodeJS.ProcessEnv = process.env): {
	agentUid?: number;
	agentGid?: number;
} {
	const parse = (raw: string | undefined): number | undefined => {
		if (raw === undefined) return undefined;
		const trimmed = raw.trim();
		if (trimmed === "") return undefined;
		const n = Number(trimmed);
		if (!Number.isInteger(n) || n < 0) return undefined;
		return n;
	};
	const agentUid = parse(env.NIGHTSHIFT_AGENT_UID);
	const agentGid = parse(env.NIGHTSHIFT_AGENT_GID);
	return {
		...(agentUid !== undefined ? { agentUid } : {}),
		...(agentGid !== undefined ? { agentGid } : {}),
	};
}

/**
 * Pure builder: the SandboxProfile for an interactive coder run — worktree rw,
 * per-task HOME rw, provider auth dir ro, and the agent's explicit env
 * allowlist (the same `env` buildAgentInvocation constructed — NEVER the host
 * GitHub token / SSH agent / process.env).
 */
export function buildCoderSandboxProfile(input: {
	worktreePath: string;
	homePath: string;
	provider: string;
	envAllowlist: Record<string, string>;
	/** Optional: path to the main git repo root. Used to bind .git/ so linked
	 *  worktrees (whose .git is a file pointer) can resolve git operations. */
	repoDir?: string;
}): SandboxProfile {
	const authDest = providerAuthDir(input.homePath, input.provider);
	// NIGHTSHIFT_PROVIDER_BIN_DIR: extra read-only dir mounted in the sandbox so
	// provider CLIs installed outside /home (e.g. /opt/nightshift/bin/claude) are
	// accessible without violating R2:home-leak.
	const providerBinDir = process.env.NIGHTSHIFT_PROVIDER_BIN_DIR;
	const extraSysDir =
		providerBinDir && !providerBinDir.startsWith("/home") ? [providerBinDir] : [];
	// WHY no hostAuthSource: we pre-copy credentials into authDest (see spawnRun
	// step 3b) so authDest is a writable host directory that claude can also use
	// for session data (history, hooks). A ro-bind overlay would block those writes
	// and stall claude on its first run in a fresh task home.
	// Run the interactive coder under the dedicated agent uid/gid (when set in
	// env) so nftables `meta skuid <uid>` egress rules actually filter its
	// packets. Unset ⇒ undefined ⇒ no --uid/--gid ⇒ behaviour unchanged.
	const { agentUid, agentGid } = resolveAgentIds();
	return {
		worktreePath: input.worktreePath,
		taskHome: input.homePath,
		providerAuthDir: authDest,
		repoGitDir: input.repoDir ? join(input.repoDir, ".git") : undefined,
		envAllowlist: input.envAllowlist,
		roSystemDirs: ["/usr", "/bin", "/lib", "/lib64", ...extraSysDir],
		...(agentUid !== undefined ? { agentUid } : {}),
		...(agentGid !== undefined ? { agentGid } : {}),
	};
}

/**
 * Copy provider credentials from NIGHTSHIFT_CLAUDE_AUTH_DIR into the
 * per-task providerAuthDir so claude can find them in the sandbox (taskHome
 * is mounted rw; we do NOT ro-bind the auth source to avoid blocking session
 * writes). Silently skips when the source dir is missing or not set.
 */
export function seedProviderCredentials(providerAuthDirPath: string): void {
	const src = process.env.NIGHTSHIFT_CLAUDE_AUTH_DIR;
	if (!src || src.startsWith("/home")) return;
	for (const fname of [".credentials.json", "settings.json"]) {
		const srcFile = join(src, fname);
		const dstFile = join(providerAuthDirPath, fname);
		if (existsSync(srcFile) && !existsSync(dstFile)) {
			try {
				copyFileSync(srcFile, dstFile);
			} catch {
				// ignore — missing file or permission error; claude will re-auth
			}
		}
	}
}

/**
 * Pure builder: prepend `bwrap ...buildBwrapArgs(profile) --` to the inner
 * coder command. The result is what tmux ultimately execs, so the coder runs
 * inside a private mount/namespace sandbox with no host /home visibility.
 */
export function wrapWithBwrap(profile: SandboxProfile, innerCommand: string[]): string[] {
	return ["bwrap", ...buildBwrapArgs(profile), "--", ...innerCommand];
}

/**
 * Fail-closed coder sandbox wrap (mirrors spawnSandboxed):
 *   - Linux: build the profile, run the invariant checker (any violation →
 *     SandboxDisabledError), confirm bwrap is on PATH (absent →
 *     SandboxDisabledError), then return the bwrap-wrapped command.
 *   - non-Linux: throw SandboxDisabledError UNLESS
 *     NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER === "1" (attended macOS-dev escape
 *     hatch, never set by any shipped config/unit), in which case the inner
 *     command is returned unwrapped.
 *
 * Returns the command tmux should launch.
 */
async function sandboxCoderCommand(
	innerCommand: string[],
	profile: SandboxProfile,
): Promise<string[]> {
	if (process.platform !== "linux") {
		if (process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER === "1") {
			return innerCommand;
		}
		throw new SandboxDisabledError(
			"unsandboxed coder refused off Linux (set NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER=1 for attended dev only)",
		);
	}

	const sandboxArgs = buildBwrapArgs(profile);
	const violations = checkSandboxInvariants(sandboxArgs, profile);
	if (violations.length > 0) {
		const summary = violations.map((v) => `[${v.rule}] ${v.detail}`).join("; ");
		throw new SandboxDisabledError(`invariant violations: ${summary}`);
	}

	if (!(await bwrapAvailable())) {
		throw new SandboxDisabledError(
			"bwrap not found on PATH (Linux-only; coder spawn fails closed)",
		);
	}

	return wrapWithBwrap(profile, innerCommand);
}

// ---------------------------------------------------------------------------
// spawnRun

export interface SpawnDeps {
	handle: DbHandle;
	log: EventLog;
	launcher: Launcher;
}

export interface SpawnRunInput {
	taskId: number;
	/** Run id (must already be in queued state). */
	runId: number;
	provider: string;
	prompt: string;
	/** Local path to the git repo. */
	repoDir: string;
	/** Root directory under which per-task HOME dirs are created. */
	homeRoot: string;
	/** Optional slug for worktree branch naming. */
	slug?: string;
	apiBaseUrl?: string;
	bearer?: string;
	/** Passed through to buildAgentInvocation → `--resume '<id>'` (D2). */
	resumeSessionId?: string;
	/**
	 * Workflow-skill slugs to mount into the per-task HOME before launch
	 * (blueprint integration). When set and non-empty, the matching
	 * `vendor/blueprint-skills/skills/<slug>/SKILL.md` files are copied under
	 * `<homePath>/.nightshift-skills/` and a footer pointing at them is appended
	 * to the prompt. Omit/empty = no skills mounted (backward compatible).
	 */
	skillsMount?: string[];
	/**
	 * When provided, use container isolation (via makeIsolatedSpawn) instead of
	 * the default bwrap-only path. When absent the existing sandboxCoderCommand
	 * call is used unchanged (backward compatible).
	 */
	containerConfig?: NightshiftConfig["container"];
}

/**
 * Orchestrate a full run start:
 *   1. Create (or reuse) the git worktree.
 *   2. Ensure the per-task HOME directory exists.
 *   3. Build the agent invocation (prompt-via-file).
 *   4. Launch via the injected Launcher.
 *   5. Transition queued→starting (records tmuxSession/worktreePath/homePath).
 *
 * Returns the updated RunRow (state=starting) on success.
 * Throws if the worktree creation, launch, or state transition fails.
 */
export async function spawnRun(deps: SpawnDeps, input: SpawnRunInput): Promise<RunRow> {
	const { handle, log, launcher } = deps;
	const { taskId, runId, provider, prompt, repoDir, homeRoot, slug, apiBaseUrl, bearer, resumeSessionId, skillsMount, containerConfig } =
		input;

	// Step 1: create (or reuse) the git worktree for this task.
	const wt = await createWorktree({ repoDir, taskId, slug });

	// Step 2: ensure per-task HOME directory exists.
	const homePath = join(homeRoot, String(taskId));
	mkdirSync(homePath, { recursive: true });

	// Step 2b: mount workflow skills into the per-task HOME (blueprint seam).
	// Dormant unless the caller passes slugs; the footer points the agent at
	// the copied SKILL.md files so it follows spec→plan→implement→review.
	const skillsPrompt =
		skillsMount && skillsMount.length > 0
			? appendSkillsFooter(prompt, mountSkills({ homePath, skills: skillsMount }).promptFooter)
			: prompt;

	// Step 3: build the agent invocation (writes prompt to temp file).
	const invocation = buildAgentInvocation({
		provider,
		prompt: skillsPrompt,
		worktreePath: wt.path,
		homePath,
		runId,
		apiBaseUrl,
		bearer,
		resumeSessionId,
	});

	// Step 3b: wrap the coder command in the bwrap sandbox (fail-closed). The
	// interactive coder is the primary prompt-injectable agent, so it MUST run
	// inside a private namespace with no host /home visibility (THREAT-MODEL B1).
	const profile = buildCoderSandboxProfile({
		worktreePath: wt.path,
		homePath,
		provider,
		envAllowlist: invocation.env,
		repoDir,
	});
	// Ensure the provider auth dir exists and seed credentials from the auth
	// source (NIGHTSHIFT_CLAUDE_AUTH_DIR). taskHome is mounted rw so claude
	// can write session data there; no ro-bind overlay is used.
	mkdirSync(profile.providerAuthDir, { recursive: true });
	seedProviderCredentials(profile.providerAuthDir);
	const launchCommand = containerConfig !== undefined
		? await makeIsolatedSpawn({
				containerConfig,
				deps: { bwrapFallback: sandboxCoderCommand },
		  })(invocation.command, profile)
		: await sandboxCoderCommand(invocation.command, profile);

	// Step 4: launch via the injected Launcher.
	const sessionName = `ns-${runId}`;
	let handle_: LaunchHandle;
	try {
		handle_ = await launcher.launch({
			runId,
			cwd: wt.path,
			command: launchCommand,
			env: invocation.env,
			sessionName,
		});
	} catch (err) {
		// If launch fails we still need to clean up (leave worktree per ADR-0004).
		throw new Error(
			`Failed to launch run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Step 5: transition queued→starting, recording tmux/worktree/home metadata.
	const result = await transitionRun(handle, log, {
		runId,
		to: "starting",
		expectedFrom: "queued",
		actor: "spawn",
		extra: {
			tmuxSession: handle_.sessionName,
			worktreePath: wt.path,
			homePath,
			startedAt: new Date().toISOString(),
		},
	});

	if (!result.ok) {
		// Race: another actor transitioned the run before us — kill the tmux session.
		await launcher.kill(handle_).catch(() => undefined);
		throw new Error(
			`Run ${runId} transition queued→starting failed: ${result.reason}. ` +
				`Launched session has been killed.`,
		);
	}

	return result.run;
}
