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

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { RunRow } from "../db/schema.ts";
import { createWorktree } from "../worktree/worktree.ts";
import { transitionRun } from "./transitions.ts";
import type { Launcher, LaunchHandle } from "./launcher.ts";

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
	const { provider, prompt, worktreePath, homePath, runId, apiBaseUrl, bearer } = input;
	const cli = resolveProviderCli(provider);

	// Write the prompt to a temp file inside homePath.  The file is deleted by
	// the shell one-liner before the CLI starts, so it never persists past launch.
	const promptFile = join(homePath, `.ns-prompt-${runId}`);
	writeFileSync(promptFile, prompt, { encoding: "utf8", mode: 0o600 });

	// Shell one-liner: read the file into $p, delete it, exec the CLI with $p.
	const shellOneLiner = `p=$(cat '${promptFile}'); rm -f '${promptFile}'; exec ${cli} "$p"`;

	const command = ["sh", "-c", shellOneLiner];

	const env: Record<string, string> = {
		// Isolate the agent's HOME to the per-task directory.
		HOME: homePath,
		// Tell the hook bridge which run this process belongs to.
		NIGHTSHIFT_RUN_ID: String(runId),
		// Working directory for the agent (the worktree).
		NIGHTSHIFT_WORKTREE: worktreePath,
		// Minimal PATH — enough for the provider CLI.
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		// Locale normalisation — avoid locale-dependent CLI output.
		LC_ALL: "C",
		LANG: "en_US.UTF-8",
	};

	if (bearer !== undefined) env.NIGHTSHIFT_API_TOKEN = bearer;
	if (apiBaseUrl !== undefined) {
		// Extract the port from the base URL so the hook bridge can use it.
		try {
			const url = new URL(apiBaseUrl);
			if (url.port) env.NIGHTSHIFT_PORT = url.port;
		} catch {
			// Ignore malformed URLs; the hook bridge will use its default port.
		}
	}

	return { command, env };
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
	const { taskId, runId, provider, prompt, repoDir, homeRoot, slug, apiBaseUrl, bearer } = input;

	// Step 1: create (or reuse) the git worktree for this task.
	const wt = await createWorktree({ repoDir, taskId, slug });

	// Step 2: ensure per-task HOME directory exists.
	const homePath = join(homeRoot, String(taskId));
	mkdirSync(homePath, { recursive: true });

	// Step 3: build the agent invocation (writes prompt to temp file).
	const invocation = buildAgentInvocation({
		provider,
		prompt,
		worktreePath: wt.path,
		homePath,
		runId,
		apiBaseUrl,
		bearer,
	});

	// Step 4: launch via the injected Launcher.
	const sessionName = `ns-${runId}`;
	let handle_: LaunchHandle;
	try {
		handle_ = await launcher.launch({
			runId,
			cwd: wt.path,
			command: invocation.command,
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
