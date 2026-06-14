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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { buildAgentInvocation, spawnRun, buildCoderSandboxProfile, resolveAgentIds } from "./spawn.ts";

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

	test("resumeSessionId injects --resume '<id>' into the one-liner; absent otherwise", () => {
		const homeDir = join(tmp, "home");
		mkdirSync(homeDir, { recursive: true });

		const withResume = buildAgentInvocation({
			provider: "claude-code",
			prompt: "fix the findings",
			worktreePath: "/tmp/wt",
			homePath: homeDir,
			runId: 5,
			resumeSessionId: "sess-xyz",
		});
		expect(withResume.command[2]).toContain("--resume 'sess-xyz'");
		expect(withResume.command[2]).toContain(
			"exec claude --dangerously-skip-permissions --resume 'sess-xyz' \"$p\"",
		);

		const noResume = buildAgentInvocation({
			provider: "claude-code",
			prompt: "fresh start",
			worktreePath: "/tmp/wt",
			homePath: homeDir,
			runId: 6,
		});
		expect(noResume.command[2]).not.toContain("--resume");
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

	// spawnRun fails closed when bwrap is absent (macOS build host). These
	// integration tests exercise the worktree/transition orchestration, not the
	// sandbox, so opt into the attended-dev escape hatch for the macOS run.
	const prevEscapeHatch = process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER;

	beforeEach(() => {
		process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER = "1";
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

	afterEach(() => {
		if (prevEscapeHatch === undefined) {
			delete process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER;
		} else {
			process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER = prevEscapeHatch;
		}
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
			// On Linux with bwrap present the command is wrapped: ["bwrap", ..., "--", "sh", "-c", <one-liner>].
			// On other platforms (NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER=1) it is bare: ["sh", "-c", <one-liner>].
			const separatorIdx = cmd.indexOf("--");
			const innerCmd = separatorIdx >= 0 ? cmd.slice(separatorIdx + 1) : cmd;
			expect(innerCmd[0]).toBe("sh");
			expect(innerCmd[1]).toBe("-c");

			const shellStr = innerCmd[2];
			expect(typeof shellStr).toBe("string");
			expect(shellStr).toContain("cat");
			expect(shellStr).toContain("rm");
			expect(shellStr).toContain("exec");
		},
		{ timeout: 15_000 },
	);

	test(
		"skillsMount mounts the vendored skill into HOME and footers the prompt",
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
					prompt: "build the thing",
					repoDir,
					homeRoot,
					skillsMount: ["implement"],
				},
			);

			// The vendored skill must be copied into the per-task HOME.
			const homePath = join(homeRoot, String(taskId));
			const mounted = join(homePath, ".nightshift-skills", "implement", "SKILL.md");
			expect(existsSync(mounted)).toBe(true);

			// The prompt-via-file temp file (not yet consumed under FakeLauncher) must
			// carry the footer pointing the agent at the mounted skill.
			const promptFile = join(homePath, `.ns-prompt-${runId}`);
			const written = readFileSync(promptFile, "utf8");
			expect(written).toContain("build the thing");
			expect(written).toContain("Workflow skills");
			expect(written).toContain(mounted);
		},
		{ timeout: 15_000 },
	);
});

describe("resolveAgentIds", () => {
	test("returns {} when env is empty", () => {
		expect(resolveAgentIds({})).toEqual({});
	});

	test("parses NIGHTSHIFT_AGENT_UID / NIGHTSHIFT_AGENT_GID", () => {
		expect(resolveAgentIds({ NIGHTSHIFT_AGENT_UID: "999", NIGHTSHIFT_AGENT_GID: "998" })).toEqual({
			agentUid: 999,
			agentGid: 998,
		});
	});

	test("uid alone yields only agentUid", () => {
		expect(resolveAgentIds({ NIGHTSHIFT_AGENT_UID: "999" })).toEqual({ agentUid: 999 });
	});

	test("blank / non-numeric / negative values are ignored (fail to unset)", () => {
		expect(resolveAgentIds({ NIGHTSHIFT_AGENT_UID: "" })).toEqual({});
		expect(resolveAgentIds({ NIGHTSHIFT_AGENT_UID: "  " })).toEqual({});
		expect(resolveAgentIds({ NIGHTSHIFT_AGENT_UID: "abc" })).toEqual({});
		expect(resolveAgentIds({ NIGHTSHIFT_AGENT_UID: "-5" })).toEqual({});
		expect(resolveAgentIds({ NIGHTSHIFT_AGENT_UID: "9.5" })).toEqual({});
	});
});

describe("buildCoderSandboxProfile — agent uid threading", () => {
	const baseInput = {
		worktreePath: "/opt/nightshift/worktrees/task-7",
		homePath: "/opt/nightshift/homes/7",
		provider: "claude-code",
		envAllowlist: { PATH: "/usr/bin" },
	};

	test("omits agentUid/agentGid when env unset (default unchanged)", () => {
		const prevU = process.env.NIGHTSHIFT_AGENT_UID;
		const prevG = process.env.NIGHTSHIFT_AGENT_GID;
		delete process.env.NIGHTSHIFT_AGENT_UID;
		delete process.env.NIGHTSHIFT_AGENT_GID;
		try {
			const p = buildCoderSandboxProfile(baseInput);
			expect(p.agentUid).toBeUndefined();
			expect(p.agentGid).toBeUndefined();
		} finally {
			if (prevU === undefined) delete process.env.NIGHTSHIFT_AGENT_UID;
			else process.env.NIGHTSHIFT_AGENT_UID = prevU;
			if (prevG === undefined) delete process.env.NIGHTSHIFT_AGENT_GID;
			else process.env.NIGHTSHIFT_AGENT_GID = prevG;
		}
	});

	test("threads agentUid/agentGid from env", () => {
		const prevU = process.env.NIGHTSHIFT_AGENT_UID;
		const prevG = process.env.NIGHTSHIFT_AGENT_GID;
		process.env.NIGHTSHIFT_AGENT_UID = "999";
		process.env.NIGHTSHIFT_AGENT_GID = "998";
		try {
			const p = buildCoderSandboxProfile(baseInput);
			expect(p.agentUid).toBe(999);
			expect(p.agentGid).toBe(998);
		} finally {
			if (prevU === undefined) delete process.env.NIGHTSHIFT_AGENT_UID;
			else process.env.NIGHTSHIFT_AGENT_UID = prevU;
			if (prevG === undefined) delete process.env.NIGHTSHIFT_AGENT_GID;
			else process.env.NIGHTSHIFT_AGENT_GID = prevG;
		}
	});
});
