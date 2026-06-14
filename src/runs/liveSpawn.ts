/**
 * WHY: Production implementations of the three injected `ReviewDeps` seams the
 * orchestrator review engine (src/orchestrator/review.ts) needs to go live, plus
 * the captured-stdout one-shot runtime they sit on. The review/coder loop is the
 * last "not wired" stub in src/server/routes.ts; this module supplies:
 *
 *   - runReviewer: a NON-INTERACTIVE captured-stdout structured one-shot. The
 *     reviewer CLI (codex/claude) runs under bwrap on Linux via spawnSandboxed,
 *     prompt on stdin, HOME pinned to the per-task dir, the GitHub token NEVER in
 *     env. Recorded as a `reviewer` run row so verdicts carry a runId; headSha is
 *     re-resolved AFTER the one-shot exits so the engine's SHA-binding check is
 *     honest (LIVE-WIRING D1/D6).
 *   - resumeCoder: resumes the INTERACTIVE tmux coder via `--resume '<sessionId>'`
 *     (the session id the hook bridge captured on SessionStart). Creates a fresh
 *     `coder` run row and spawns through the normal Launcher path (D2).
 *   - getDiff: host-side `git diff base..HEAD` of the latest coder worktree (D6).
 *
 * FAIL-CLOSED everywhere: a missing provider binary (bwrap absent / unknown
 * provider), a missing coder session, a missing baseSha, or a non-zero one-shot
 * exit THROWS — never a silent no-op, never fabricated output. Every side effect
 * (spawner, launcher, git runner) is injectable so this module is fully testable
 * on macOS with fakes; the owner verifies the live paths on Linux.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { TaskRow, FindingRow } from "../db/schema.ts";
import { runs } from "../db/schema.ts";
import { eq, and, desc, isNotNull } from "drizzle-orm";
import { getTask } from "../tasks/tasks.ts";
import { createRun } from "./runs.ts";
import { transitionRun } from "./transitions.ts";
import { spawnRun, type SpawnDeps, seedProviderCredentials, resolveAgentIds } from "./spawn.ts";
import { execGit } from "../worktree/git.ts";
import { TmuxLauncher, type Launcher } from "./launcher.ts";
import { spawnSandboxed } from "../sandbox/spawn.ts";
import type { SandboxProfile } from "../sandbox/profile.ts";
import type { ReviewDeps, ReviewerRunResult } from "../orchestrator/review.ts";
import { makeTournamentRunner } from "../review/tournament.ts";
import type { TiebreakDeps } from "../review/tiebreaker.ts";
import { makeTiebreakerReviewer } from "../orchestrator/tiebreakerReviewer.ts";

// ---------------------------------------------------------------------------
// One-shot runtime (LIVE-WIRING D1)
// ---------------------------------------------------------------------------

export class OneShotDisabledError extends Error {
	constructor(reason: string) {
		super(`One-shot spawn disabled — ${reason}`);
		this.name = "OneShotDisabledError";
	}
}

export interface OneShotSpec {
	/** Built by buildOneShotArgv — NEVER includes the prompt. */
	argv: string[];
	/** ALWAYS delivered via stdin (no ps leak, no temp-file cleanup race). */
	prompt: string;
	/** Reviewer: the task worktree. Planner: a scratch dir. */
	cwd: string;
	/** Per-task HOME (reviewer: homeRoot/<taskId>). */
	home: string;
	/** ro-bound provider credential dir (e.g. <home>/.claude). */
	providerAuthDir: string;
	/**
	 * Optional: path to the main repo's .git directory. Required when cwd is a
	 * linked worktree so git operations inside bwrap can resolve the gitdir pointer.
	 * Mirrors buildCoderSandboxProfile's repoGitDir field (spawn.ts).
	 */
	repoGitDir?: string;
	/** Default 600_000; on expiry kill() and throw. */
	timeoutMs?: number;
}

export interface OneShotResult {
	stdout: string;
	exitCode: number;
}

/** Injectable spawner so tests never create processes. */
export type OneShotSpawner = (spec: OneShotSpec) => Promise<OneShotResult>;

/** Provider CLI executable name by driver name (one-shot lane). */
const ONESHOT_CLI: Record<string, string[]> = {
	// claude --print: non-interactive, prints the final message, prompt on stdin.
	"claude-code": ["claude", "--print"],
	claudeCode: ["claude", "--print"],
	// codex exec -: non-interactive one-shot, prompt on stdin.
	// NOTE: codex flag spelling is a Linux-verify item; adjust HERE only.
	codex: ["codex", "exec", "-"],
};

/**
 * Pure argv builder — THE single place one-shot provider CLI flags live.
 * Unknown provider ⇒ throw OneShotDisabledError (fail-closed).
 */
export function buildOneShotArgv(provider: string): string[] {
	const argv = ONESHOT_CLI[provider];
	if (argv === undefined) {
		throw new OneShotDisabledError(`unknown one-shot provider '${provider}'`);
	}
	return [...argv];
}

/**
 * Pure env builder — minimal allowlist; NEVER a GitHub token, NIGHTSHIFT_*, or
 * SSH_AUTH_SOCK. HOST-SIDE TOKEN INVARIANT (LIVE-WIRING §0).
 *
 * NIGHTSHIFT_PROVIDER_BIN_DIR is prepended to PATH (when set) so that provider
 * CLIs installed outside /home (e.g. /opt/nightshift/bin/claude) are discoverable
 * under bwrap --clearenv (mirrors buildAgentInvocation in spawn.ts ~lines 120-125).
 */
export function buildOneShotEnv(home: string): Record<string, string> {
	return {
		HOME: home,
		PATH: [
			process.env.NIGHTSHIFT_PROVIDER_BIN_DIR,
			"/usr/local/bin",
			"/usr/bin",
			"/bin",
		].filter(Boolean).join(":"),
		LC_ALL: "C",
		LANG: "en_US.UTF-8",
	};
}

const DEFAULT_ONESHOT_TIMEOUT_MS = 600_000;

/**
 * The live spawner.
 *
 *   1. Linux: spawn the argv inside a bwrap sandbox (spawnSandboxed). bwrap
 *      absent ⇒ SandboxDisabledError propagates (fail-closed).
 *   2. non-Linux: throw OneShotDisabledError UNLESS
 *      NIGHTSHIFT_ALLOW_UNSANDBOXED_ONESHOTS === "1" (attended-dev escape hatch,
 *      never set by any shipped config/unit).
 *   3. Non-zero exit or timeout ⇒ throw (the engine escalates to needs_human).
 *
 * The prompt is written to stdin then stdin is closed; stdout is captured.
 */
export const spawnOneShotCaptured: OneShotSpawner = async (spec) => {
	const timeoutMs = spec.timeoutMs ?? DEFAULT_ONESHOT_TIMEOUT_MS;
	const env = buildOneShotEnv(spec.home);

	let proc: import("bun").Subprocess;
	if (process.platform === "linux") {
		// Mirror buildCoderSandboxProfile: honour NIGHTSHIFT_CLAUDE_AUTH_DIR so
		// the one-shot reviewer/planner path can find credentials outside /home.
		const hostAuthEnv = process.env.NIGHTSHIFT_CLAUDE_AUTH_DIR;
		const hostAuthSource =
			hostAuthEnv && !hostAuthEnv.startsWith("/home") ? hostAuthEnv : undefined;
		// Run reviewer/planner/optimizer one-shots under the dedicated agent
		// uid/gid (when set in env) so they are uid-scoped for nftables egress
		// enforcement, exactly like the interactive coder. Unset ⇒ unchanged.
		const { agentUid, agentGid } = resolveAgentIds();
		const profile: SandboxProfile = {
			worktreePath: spec.cwd,
			taskHome: spec.home,
			providerAuthDir: spec.providerAuthDir,
			hostAuthSource,
			// Pass repoGitDir so git operations inside bwrap succeed when the cwd is
			// a linked worktree (mirrors buildCoderSandboxProfile in spawn.ts).
			repoGitDir: spec.repoGitDir,
			envAllowlist: env,
			...(agentUid !== undefined ? { agentUid } : {}),
			...(agentGid !== undefined ? { agentGid } : {}),
		};
		proc = await spawnSandboxed(profile, spec.argv);
	} else if (process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_ONESHOTS === "1") {
		proc = Bun.spawn(spec.argv, {
			cwd: spec.cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
	} else {
		throw new OneShotDisabledError(
			"unsandboxed one-shots refused off Linux (set NIGHTSHIFT_ALLOW_UNSANDBOXED_ONESHOTS=1 for attended dev only)",
		);
	}

	// Deliver the prompt via stdin then close it.
	const stdin = proc.stdin as import("bun").FileSink;
	stdin.write(new TextEncoder().encode(spec.prompt));
	await stdin.end();

	// Enforce the wall-clock timeout: kill and throw on expiry.
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);

	let stdout = "";
	let stderr = "";
	let exitCode: number;
	try {
		[stdout, stderr] = await Promise.all([
			new Response(proc.stdout as ReadableStream).text(),
			new Response(proc.stderr as ReadableStream).text(),
		]);
		exitCode = await proc.exited;
	} finally {
		clearTimeout(timer);
	}

	if (timedOut) {
		throw new OneShotDisabledError(`one-shot timed out after ${timeoutMs}ms`);
	}
	if (exitCode !== 0) {
		const stderrSuffix = stderr.trim() ? `\nstderr: ${stderr.trim()}` : "";
		throw new OneShotDisabledError(`one-shot exited non-zero (${exitCode})${stderrSuffix}`);
	}

	return { stdout, exitCode };
};

// ---------------------------------------------------------------------------
// Shared injection surface
// ---------------------------------------------------------------------------

/** Host-side git runner (default execGit). */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export interface LiveDeps {
	handle: DbHandle;
	log: EventLog;
	/** Default execGit. */
	git?: GitRunner;
	/** Default spawnOneShotCaptured. */
	spawner?: OneShotSpawner;
	/** Default new TmuxLauncher(). */
	launcher?: Launcher;
	/** Root dir under which per-task HOME dirs live (default ~/.nightshift/homes). */
	homeRoot?: string;
	/** Local path to the git repo (used by spawnRun in resumeCoder). */
	repoDir?: string;
	/** Reviewer provider (default "codex" — LIVE-WIRING D6). */
	reviewerProvider?: string;
	/** When set, tournament mode runs this second provider in parallel and synthesizes results. */
	tournamentChallengerProvider?: string;
	/**
	 * Three-model tiebreaker provider (§7.7). When set (non-empty), tournament mode
	 * consults this THIRD model as the deciding vote whenever the primary and
	 * challenger disagree on the binary approve/block verdict. Empty/undefined ⇒ no
	 * tiebreaker (fail-closed: stricter/block wins on disagreement, as before).
	 */
	tiebreakerProvider?: string;
}

// ---------------------------------------------------------------------------
// latestCoderSessionId / latestCoderWorktree
// ---------------------------------------------------------------------------

/**
 * Resolve the coder session id to resume: latest run for the task with
 * kind='coder' AND sessionId IS NOT NULL, ordered by id DESC (LIVE-WIRING D2).
 * Returns null when none exists (caller decides fail-closed behaviour).
 */
export function latestCoderSessionId(handle: DbHandle, taskId: number): string | null {
	const row = handle.db
		.select({ sessionId: runs.sessionId })
		.from(runs)
		.where(and(eq(runs.taskId, taskId), eq(runs.kind, "coder"), isNotNull(runs.sessionId)))
		.orderBy(desc(runs.id))
		.limit(1)
		.get();
	return row?.sessionId ?? null;
}

/** Latest coder run's worktreePath (the diff source). Null when none. */
function latestCoderWorktree(handle: DbHandle, taskId: number): string | null {
	const row = handle.db
		.select({ worktreePath: runs.worktreePath })
		.from(runs)
		.where(and(eq(runs.taskId, taskId), eq(runs.kind, "coder"), isNotNull(runs.worktreePath)))
		.orderBy(desc(runs.id))
		.limit(1)
		.get();
	return row?.worktreePath ?? null;
}

// ---------------------------------------------------------------------------
// buildFindingsPrompt (pure)
// ---------------------------------------------------------------------------

/**
 * Pure builder: turn review findings into the coder's next-turn prompt
 * (file/severity/description/suggestion per finding + "fix and commit" frame).
 */
export function buildFindingsPrompt(findings: FindingRow[]): string {
	const lines: string[] = [
		"Code review found issues that must be fixed. Address every item below,",
		"then commit your changes.",
		"",
	];
	findings.forEach((f, i) => {
		const file = f.filePathNew ?? f.filePathOld ?? "(no file)";
		lines.push(`${i + 1}. [${f.severity}] ${file}`);
		lines.push(`   ${f.description}`);
		if (f.suggestion) lines.push(`   Suggestion: ${f.suggestion}`);
		lines.push("");
	});
	lines.push("Fix each issue and commit. Do not introduce unrelated changes.");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// getDiff (LIVE-WIRING D6)
// ---------------------------------------------------------------------------

/**
 * Build the injected `getDiff` closure: host-side `git diff <baseSha>..HEAD` of
 * the latest coder worktree. Fail-closed: missing worktree or empty baseSha
 * throws. headSha = `git rev-parse HEAD` (trimmed).
 */
export function makeGetDiff(deps: LiveDeps): ReviewDeps["getDiff"] {
	const git = deps.git ?? execGit;
	return async (task: TaskRow) => {
		const wt = latestCoderWorktree(deps.handle, task.id);
		if (wt === null) {
			throw new Error(`no coder worktree to diff for task ${task.id}`);
		}
		if (!task.baseSha) {
			throw new Error(`task ${task.id} has no baseSha — cannot diff`);
		}
		const headSha = (await git(["rev-parse", "HEAD"], wt)).trim();
		const diff = await git(["diff", `${task.baseSha}..HEAD`], wt);
		return {
			diff,
			headSha,
			prTitle: `[ns#${task.id}] ${task.title}`,
			prBody: task.description ?? "",
		};
	};
}

// ---------------------------------------------------------------------------
// runReviewer (LIVE-WIRING D1/D6)
// ---------------------------------------------------------------------------

/**
 * Build the injected `runReviewer` closure: one captured-stdout reviewer
 * one-shot per turn. Records a `reviewer` run row (queued→starting→running→
 * finishing→succeeded|failed) so the verdict carries a runId. headSha is
 * re-resolved AFTER the one-shot exits (D6). A spawn failure transitions the run
 * to failed and rethrows (fail-closed).
 */
export function makeRunReviewer(deps: LiveDeps): ReviewDeps["runReviewer"] {
	const spawner = deps.spawner ?? spawnOneShotCaptured;
	const git = deps.git ?? execGit;
	const provider = deps.reviewerProvider ?? "codex";
	const homeRoot = deps.homeRoot ?? defaultHomeRoot();

	return async (input): Promise<ReviewerRunResult> => {
		const { task } = input;
		const wt = latestCoderWorktree(deps.handle, task.id);
		if (wt === null) {
			throw new Error(`no coder worktree to review for task ${task.id}`);
		}

		// authLane: "subscription" for claude-code, "api_key" for codex (D6).
		const authLane = provider === "codex" ? "api_key" : "subscription";
		const run = await createRun(deps.handle, {
			taskId: task.id,
			kind: "reviewer",
			provider,
			model: "cli-default",
			authLane,
		});

		// queued → starting → running. No tmux/watchdog for one-shots.
		const home = `${homeRoot}/${task.id}`;

		// Mirror the coder path (spawn.ts ~337-338, 373-374): ensure the per-task
		// HOME and provider auth dir exist, then seed credentials so the reviewer
		// CLI can find them inside the bwrap sandbox.
		const authDir = providerAuthDir(home, provider);
		mkdirSync(home, { recursive: true });
		mkdirSync(authDir, { recursive: true });
		seedProviderCredentials(authDir);

		await transitionRun(deps.handle, deps.log, {
			runId: run.id,
			to: "starting",
			expectedFrom: "queued",
			actor: "reviewer",
			extra: { worktreePath: wt, homePath: home },
		});
		await transitionRun(deps.handle, deps.log, {
			runId: run.id,
			to: "running",
			expectedFrom: "starting",
			actor: "reviewer",
		});

		// repoGitDir: needed for git ops inside bwrap when wt is a linked worktree
		// (mirrors buildCoderSandboxProfile's repoDir → join(repoDir, ".git")).
		const repoGitDir = deps.repoDir ? join(deps.repoDir, ".git") : undefined;

		let result: OneShotResult;
		try {
			result = await spawner({
				argv: buildOneShotArgv(provider),
				prompt: input.prompt,
				cwd: wt,
				home,
				providerAuthDir: authDir,
				repoGitDir,
			});
		} catch (err) {
			// Fail-closed: failed produce → the engine escalates to needs_human.
			await transitionRun(deps.handle, deps.log, {
				runId: run.id,
				to: "finishing",
				expectedFrom: "running",
				actor: "reviewer",
			});
			await transitionRun(deps.handle, deps.log, {
				runId: run.id,
				to: "failed",
				expectedFrom: "finishing",
				actor: "reviewer",
				extra: { exitReason: err instanceof Error ? err.message : String(err) },
			});
			throw err;
		}

		// Re-resolve headSha AFTER the one-shot exits so review.ts's SHA-binding
		// check is honest (D6).
		const headSha = (await git(["rev-parse", "HEAD"], wt)).trim();

		await transitionRun(deps.handle, deps.log, {
			runId: run.id,
			to: "finishing",
			expectedFrom: "running",
			actor: "reviewer",
		});
		await transitionRun(deps.handle, deps.log, {
			runId: run.id,
			to: "succeeded",
			expectedFrom: "finishing",
			actor: "reviewer",
		});

		return { stdout: result.stdout, runId: run.id, headSha, provider };
	};
}

/**
 * Build the §3.4 specialist-finder producer for one task: each call spawns a
 * captured reviewer one-shot with the specialist's prompt and returns its raw
 * stdout for the harness to parse. Finders are READ-ONLY (no run row, no commit,
 * no headSha re-resolve) — they only read the diff in the prompt.
 *
 * FAIL-SOFT per finder: a missing coder worktree or a spawn failure returns "" so
 * that ONE bad finder is recorded by the harness as a parse-failure (not fatal)
 * rather than rejecting the whole Promise.all. When EVERY finder returns "" the
 * harness fail-closes to "block" (no evidence ⇒ never approve), which is correct.
 */
export function makeProduceFinder(
	deps: LiveDeps,
	task: TaskRow,
): (kind: string, prompt: string) => Promise<string> {
	const spawner = deps.spawner ?? spawnOneShotCaptured;
	const provider = deps.reviewerProvider ?? "codex";
	const homeRoot = deps.homeRoot ?? defaultHomeRoot();

	return async (_kind: string, prompt: string): Promise<string> => {
		const wt = latestCoderWorktree(deps.handle, task.id);
		if (wt === null) return ""; // no worktree to review → no evidence (harness blocks if all fail)
		const home = `${homeRoot}/${task.id}`;
		try {
			const result = await spawner({
				argv: buildOneShotArgv(provider),
				prompt,
				cwd: wt,
				home,
				providerAuthDir: providerAuthDir(home, provider),
			});
			return result.stdout;
		} catch (err) {
			console.warn(
				`[produceFinder] specialist spawn failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return ""; // fail-soft: empty stdout → harness records a failed finder
		}
	};
}

/**
 * Like `makeRunReviewer` but wraps the result in tournament mode:
 * spawns a second challenger reviewer in parallel and synthesizes the union.
 * Falls back gracefully: if either runner errors, the other's output is used.
 */
export function makeTournamentReviewer(deps: LiveDeps): ReviewDeps["runReviewer"] {
	const primaryRunner = makeRunReviewer(deps);
	const challengerRunner = makeRunReviewer({
		...deps,
		reviewerProvider: deps.tournamentChallengerProvider,
	});

	// §7.7 three-model tiebreaker: build the third-model seam only when a
	// non-empty tiebreakerProvider is configured. makeTiebreakerReviewer validates
	// the provider eagerly (throws OneShotDisabledError on unknown) so wiring
	// errors surface at startup, not at first tie.
	const tiebreakerDeps: TiebreakDeps | undefined = deps.tiebreakerProvider
		? {
				runTiebreaker: makeTiebreakerReviewer({
					tiebreakerProvider: deps.tiebreakerProvider,
					...(deps.homeRoot !== undefined ? { homeRoot: deps.homeRoot } : {}),
				}),
			}
		: undefined;

	return makeTournamentRunner(primaryRunner, challengerRunner, tiebreakerDeps);
}

// ---------------------------------------------------------------------------
// resumeCoder (LIVE-WIRING D2)
// ---------------------------------------------------------------------------

/**
 * Build the injected `resumeCoder` closure: resume the interactive tmux coder
 * via `--resume '<sessionId>'`, feeding the findings prompt as the next turn.
 * Creates a fresh `coder` run row, reuses the existing worktree (createWorktree
 * is idempotent), and spawns through the normal Launcher path. Fail-closed: no
 * resumable coder session ⇒ throw.
 */
export function makeResumeCoder(deps: LiveDeps): ReviewDeps["resumeCoder"] {
	const launcher = deps.launcher ?? new TmuxLauncher();
	const homeRoot = deps.homeRoot ?? defaultHomeRoot();

	return async (input): Promise<{ runId: number }> => {
		const { task, findings } = input;

		const sessionId = latestCoderSessionId(deps.handle, task.id);
		if (sessionId === null) {
			throw new Error(`no coder session to resume for task ${task.id}`);
		}

		const repoDir = deps.repoDir ?? resolveRepoDir(deps.handle, task);

		const run = await createRun(deps.handle, {
			taskId: task.id,
			kind: "coder",
			provider: "claude-code",
			model: "cli-default",
			authLane: "subscription",
		});

		const spawnDeps: SpawnDeps = { handle: deps.handle, log: deps.log, launcher };
		await spawnRun(spawnDeps, {
			taskId: task.id,
			runId: run.id,
			provider: "claude-code",
			prompt: buildFindingsPrompt(findings),
			repoDir,
			homeRoot,
			resumeSessionId: sessionId,
		});

		return { runId: run.id };
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function defaultHomeRoot(): string {
	return `${process.env.HOME ?? "/tmp"}/.nightshift/homes`;
}

/** ro-bound provider credential dir under the per-task HOME. */
function providerAuthDir(home: string, provider: string): string {
	return provider === "codex" ? `${home}/.codex` : `${home}/.claude`;
}

/** Fall back to the project repoUrl only when no explicit repoDir was injected. */
function resolveRepoDir(handle: DbHandle, task: TaskRow): string {
	// repoDir must be a local path; the project's repoUrl is a remote. The
	// caller (INT) is expected to inject deps.repoDir. Fail-closed otherwise.
	void getTask(handle, task.id);
	throw new Error(
		`resumeCoder needs an explicit repoDir for task ${task.id} (inject LiveDeps.repoDir)`,
	);
}
