/**
 * Injectable process launcher abstraction (task 2.5).
 *
 * The engine never spawns real processes directly — it calls a `Launcher`
 * implementation so the scheduler is fully testable without real claude/tmux.
 *
 * Two implementations:
 *   - `TmuxLauncher`: real tmux sessions — used in production.
 *   - `FakeLauncher`:  in-memory map — used in tests, zero OS side-effects.
 *
 * LC_ALL=C is forced on all tmux calls so locale-dependent output (e.g. tmux
 * error messages) doesn't vary between environments.
 */

import { join } from "node:path";

// ---------------------------------------------------------------------------
// Public interfaces

export interface LaunchSpec {
	runId: number;
	cwd: string;
	command: string[];
	env: Record<string, string>;
	sessionName: string;
}

export interface LaunchHandle {
	sessionName: string;
	/** PID of the outer shell (best-effort; may be undefined for tmux launches). */
	pid?: number;
}

export interface Launcher {
	launch(spec: LaunchSpec): Promise<LaunchHandle>;
	isAlive(handle: LaunchHandle): Promise<boolean>;
	kill(handle: LaunchHandle): Promise<void>;
}

// ---------------------------------------------------------------------------
// TmuxLauncher — real tmux sessions

/**
 * Shells out to tmux to create, probe, and kill sessions.
 *
 * REAP NOTE: `tmux kill-session` sends SIGHUP to the process group of the
 * session's child processes (the CLI and its descendants), so there is no
 * separate `pkill` step needed when using TmuxLauncher — kill-session covers
 * the provider CLI.
 */
export class TmuxLauncher implements Launcher {
	/** Spawn a detached tmux session running `command` in `cwd`. */
	async launch(spec: LaunchSpec): Promise<LaunchHandle> {
		const { sessionName, cwd, command, env } = spec;

		// Build a shell-escaped command string for tmux's `new-session` argument.
		// We pass the command as the shell string to `sh -c`, so single-quoting
		// each token is safe for tokens that may contain spaces.
		const shellStr = command.map((t) => `'${t.replace(/'/g, "'\\''")}'`).join(" ");

		// SESSION env (HOST-SIDE TOKEN INVARIANT, LIVE-WIRING §0): only the caller's
		// explicit allowlist is injected into the coder's tmux session via `-e`.
		// process.env is NOT merged here — doing so would smuggle GITHUB_TOKEN,
		// ANTHROPIC_API_KEY, OPENAI_API_KEY, NIGHTSHIFT_API_TOKEN and SSH_AUTH_SOCK
		// onto the session env (readable via /proc/self/environ) AND onto the tmux
		// process argv (visible via `ps aux`). The coder must receive only what
		// buildAgentInvocation constructed.
		const sessionEnv: Record<string, string> = { ...env, LC_ALL: "C" };

		// Pass each session env var as `-e KEY=VALUE` so tmux injects them into
		// the session — allowlist only, never the launcher's process env.
		const envArgs = Object.entries(sessionEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

		const proc = Bun.spawn(
			[
				"tmux",
				"new-session",
				"-d",
				"-s",
				sessionName,
				"-c",
				cwd,
				...envArgs,
				shellStr,
			],
			{
				// The tmux CLIENT process needs PATH (and friends) to exec tmux;
				// this env is NOT inherited by the session (that comes from `-e`).
				env: { ...process.env, LC_ALL: "C" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const errText = await new Response(proc.stderr).text();
			throw new Error(`tmux new-session failed (exit ${exitCode}): ${errText.trim()}`);
		}

		return { sessionName };
	}

	/** True when `tmux has-session -t <sessionName>` exits 0. */
	async isAlive(handle: LaunchHandle): Promise<boolean> {
		const proc = Bun.spawn(["tmux", "has-session", "-t", handle.sessionName], {
			env: { ...process.env, LC_ALL: "C" } as Record<string, string>,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		return exitCode === 0;
	}

	/**
	 * Kill the tmux session.  `tmux kill-session` sends SIGHUP to the child
	 * process group, which covers the provider CLI and all its descendants.
	 * No separate pkill step is needed.
	 */
	async kill(handle: LaunchHandle): Promise<void> {
		const proc = Bun.spawn(["tmux", "kill-session", "-t", handle.sessionName], {
			env: { ...process.env, LC_ALL: "C" } as Record<string, string>,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		// Ignore exit code: if the session is already gone the kill is a no-op.
	}
}

// ---------------------------------------------------------------------------
// FakeLauncher — in-memory, no OS side-effects

interface FakeSession {
	spec: LaunchSpec;
	alive: boolean;
}

/**
 * In-memory launcher for tests. Tracks launched/killed/alive sessions without
 * spawning any real process. Exposes the internal map for assertions.
 */
export class FakeLauncher implements Launcher {
	readonly sessions = new Map<string, FakeSession>();

	async launch(spec: LaunchSpec): Promise<LaunchHandle> {
		this.sessions.set(spec.sessionName, { spec, alive: true });
		return { sessionName: spec.sessionName };
	}

	async isAlive(handle: LaunchHandle): Promise<boolean> {
		return this.sessions.get(handle.sessionName)?.alive ?? false;
	}

	async kill(handle: LaunchHandle): Promise<void> {
		const session = this.sessions.get(handle.sessionName);
		if (session) {
			session.alive = false;
		}
	}

	/** Convenience: mark a session as dead without going through kill(). */
	markDead(sessionName: string): void {
		const session = this.sessions.get(sessionName);
		if (session) session.alive = false;
	}

	/** Convenience: check whether a session was ever launched. */
	wasLaunched(sessionName: string): boolean {
		return this.sessions.has(sessionName);
	}

	/** Convenience: check whether a session was killed. */
	wasKilled(sessionName: string): boolean {
		return !(this.sessions.get(sessionName)?.alive ?? true);
	}
}
