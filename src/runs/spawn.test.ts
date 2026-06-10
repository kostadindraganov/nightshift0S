/**
 * spawnRun tests.
 *
 *   (a) buildAgentInvocation: command contains `cat`, `rm`, `exec` (prompt-via-file trick).
 *   (b) buildAgentInvocation: env injects HOME, NIGHTSHIFT_RUN_ID, NIGHTSHIFT_API_TOKEN,
 *       NIGHTSHIFT_PORT.
 *   (c) spawnRun: creates the worktree, transitions the run to starting with
 *       tmuxSession/homePath set, and the prompt-via-file temp file is created
 *       then consumed by the command string (verified via command text).
 */

import { beforeEach, afterEach, expect, test, describe } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects, runs, tasks } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { FakeLauncher } from "./launcher.ts";
import { buildAgentInvocation, spawnRun } from "./spawn.ts";

// ---------------------------------------------------------------------------
// Helpers

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "ns-spawn-test-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

/**
 * Create a minimal git repo with a single commit so worktrees can be created.
 * Returns the repo path.
 */
function makeGitRepo(): string {
	const repoDir = join(tmp, "repo");
	mkdirSync(repoDir, { recursive: true });

	const git = (args: string[]) =>
		spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });

	git(["init", "--initial-branch=main"]);
	git(["config", "user.email", "test@nightshift.test"]);
	git(["config", "user.name", "Test"]);
	// Create an initial commit so worktrees can be created.
	writeFileSync(join(repoDir, "README"), "test repo");
	git(["add", "README"]);
	git(["commit", "--no-gpg-sign", "-m", "init"]);

	return repoDir;
}

// ---------------------------------------------------------------------------
// (a) + (b) buildAgentInvocation unit tests

describe("buildAgentInvocation", () => {
	test("command contains sh -c with cat, rm, exec", () => {
		const homeDir = join(tmp, "home");
		mkdirSync(homeDir, { recursive: true });

		const result = buildAgentInvocation({
			provider: "claude-code",
			prompt: "do the thing",
			worktreePath: "/tmp/wt",
			homePath: homeDir,
			runId: 42,
		});

		// Command must be: ["sh", "-c", <one-liner>]
		expect(result.command[0]).toBe("sh");
		expect(result.command[1]).toBe("-c");

		const shellStr = result.command[2];
		expect(typeof shellStr).toBe("string");
		expect(shellStr).toContain("cat");
		expect(shellStr).toContain("rm");
		expect(shellStr).toContain("exec");
		expect(shellStr).toContain("claude"); // resolved CLI name
		// The prompt file path must reference the runId.
		expect(shellStr).toContain("42");
	});

	test("env injects HOME, NIGHTSHIFT_RUN_ID, NIGHTSHIFT_WORKTREE", () => {
		const homeDir = join(tmp, "home");
		mkdirSync(homeDir, { recursive: true });

		const result = buildAgentInvocation({
			provider: "codex",
			prompt: "hello",
			worktreePath: "/tmp/worktree",
			homePath: homeDir,
			runId: 7,
		});

		expect(result.env.HOME).toBe(homeDir);
		expect(result.env.NIGHTSHIFT_RUN_ID).toBe("7");
		expect(result.env.NIGHTSHIFT_WORKTREE).toBe("/tmp/worktree");
	});

	test("env injects NIGHTSHIFT_API_TOKEN when bearer is provided", () => {
		const homeDir = join(tmp, "home");
		mkdirSync(homeDir, { recursive: true });

		const result = buildAgentInvocation({
			provider: "claude-code",
			prompt: "test",
			worktreePath: "/tmp/wt",
			homePath: homeDir,
			runId: 1,
			bearer: "tok-abc123",
		});

		expect(result.env.NIGHTSHIFT_API_TOKEN).toBe("tok-abc123");
	});

	test("env injects NIGHTSHIFT_PORT from apiBaseUrl", () => {
		const homeDir = join(tmp, "home");
		mkdirSync(homeDir, { recursive: true });

		const result = buildAgentInvocation({
			provider: "claude-code",
			prompt: "test",
			worktreePath: "/tmp/wt",
			homePath: homeDir,
			runId: 1,
			apiBaseUrl: "http://localhost:8787",
		});

		expect(result.env.NIGHTSHIFT_PORT).toBe("8787");
	});

	test("unknown provider falls back to using provider name as CLI", () => {
		const homeDir = join(tmp, "home");
		mkdirSync(homeDir, { recursive: true });

		const result = buildAgentInvocation({
			provider: "my-custom-cli",
			prompt: "test",
			worktreePath: "/tmp/wt",
			homePath: homeDir,
			runId: 99,
		});

		const shellStr = result.command[2];
		expect(shellStr).toContain("my-custom-cli");
	});
});

// ---------------------------------------------------------------------------
// (c) spawnRun integration test

describe("spawnRun", () => {
	let handle: DbHandle;
	let log: EventLog;
	let projectId: number;

	beforeEach(() => {
		handle = openDatabase(":memory:");
		runMigrations(handle);
		log = new EventLog(handle);
		const now = new Date().toISOString();
		projectId = handle.db
			.insert(projects)
			.values({ name: "p", repoUrl: "https://example.test/r.git", createdAt: now, updatedAt: now })
			.returning()
			.get().id;
	});

	function seedTaskAndRun(): { taskId: number; runId: number } {
		const now = new Date().toISOString();
		const taskId = handle.db
			.insert(tasks)
			.values({ projectId, title: "t", state: "coding", createdAt: now, updatedAt: now })
			.returning()
			.get().id;
		const runId = handle.db
			.insert(runs)
			.values({ taskId, kind: "coder", provider: "claude-code", model: "m", authLane: "local", state: "queued" })
			.returning()
			.get().id;
		return { taskId, runId };
	}

	test(
		"spawnRun creates worktree, transitions run to starting, sets tmuxSession and homePath",
		async () => {
			const repoDir = makeGitRepo();
			const homeRoot = join(tmp, "homes");
			const launcher = new FakeLauncher();
			const { taskId, runId } = seedTaskAndRun();

			const result = await spawnRun(
				{ handle, log, launcher },
				{
					taskId,
					runId,
					provider: "claude-code",
					prompt: "write me a widget",
					repoDir,
					homeRoot,
					slug: "widget",
				},
			);

			// The run must be in `starting` state.
			expect(result.state).toBe("starting");

			// tmuxSession must be set.
			expect(result.tmuxSession).toBe(`ns-${runId}`);

			// homePath must be under homeRoot/taskId.
			expect(result.homePath).toBe(join(homeRoot, String(taskId)));

			// worktreePath must be set to something inside the repo.
			expect(typeof result.worktreePath).toBe("string");
			expect(result.worktreePath!.length).toBeGreaterThan(0);

			// The fake launcher must have been called with the right session name.
			expect(launcher.wasLaunched(`ns-${runId}`)).toBe(true);

			// DB row must match.
			const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
			expect(row.state).toBe("starting");
			expect(row.tmuxSession).toBe(`ns-${runId}`);
		},
		{ timeout: 15_000 },
	);

	test(
		"command string contains cat + rm + exec (prompt-via-file trick)",
		async () => {
			const repoDir = makeGitRepo();
			const homeRoot = join(tmp, "homes");
			const launcher = new FakeLauncher();
			const { taskId, runId } = seedTaskAndRun();

			await spawnRun(
				{ handle, log, launcher },
				{
					taskId,
					runId,
					provider: "claude-code",
					prompt: "use the prompt-via-file trick",
					repoDir,
					homeRoot,
				},
			);

			// Inspect what the launcher received.
			const session = launcher.sessions.get(`ns-${runId}`);
			expect(session).toBeDefined();

			const cmd = session!.spec.command;
			// Should be ["sh", "-c", <one-liner>]
			expect(cmd[0]).toBe("sh");
			expect(cmd[1]).toBe("-c");

			const shellStr = cmd[2];
			expect(typeof shellStr).toBe("string");
			expect(shellStr).toContain("cat");
			expect(shellStr).toContain("rm");
			expect(shellStr).toContain("exec");
		},
		{ timeout: 15_000 },
	);
});
