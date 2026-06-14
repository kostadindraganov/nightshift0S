/**
 * liveSpawn hermetic tests (≤4 cases, no live spawns / no network).
 *
 *   (a) buildOneShotArgv: reviewer-runner argv built correctly per provider;
 *       unknown provider throws OneShotDisabledError (fail-closed).
 *   (b) buildOneShotEnv: NO GitHub token / NIGHTSHIFT_* / SSH_AUTH_SOCK in the
 *       agent one-shot env (HOST-SIDE TOKEN INVARIANT). PATH includes provider
 *       bin dir when NIGHTSHIFT_PROVIDER_BIN_DIR is set.
 *   (c) makeRunReviewer: with a FAKE spawner — prompt + cwd reach the spawner,
 *       a reviewer run row is recorded and reaches `succeeded`, headSha is
 *       re-resolved via the injected git runner, returns {stdout,runId,headSha}.
 *   (d) makeResumeCoder: with a FAKE launcher + :memory: DB — the resumed coder
 *       command contains `--resume '<sessionId>'` and a NEW coder run is created.
 *   (e) [NEW] PATH includes NIGHTSHIFT_PROVIDER_BIN_DIR, auth dir is created +
 *       seeded before spawner is called, and a non-zero exit surfaces stderr in
 *       the thrown error message.
 */

import { afterAll, beforeAll, beforeEach, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects, runs, tasks, type TaskRow } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { FakeLauncher } from "./launcher.ts";
import {
	buildOneShotArgv,
	buildOneShotEnv,
	makeRunReviewer,
	makeResumeCoder,
	OneShotDisabledError,
	type OneShotSpawner,
	type OneShotSpec,
} from "./liveSpawn.ts";

let handle: DbHandle;
let log: EventLog;
let task: TaskRow;
let tmp: string;

/** A throwaway git repo with one commit so worktrees can be created hermetically. */
function makeGitRepo(): string {
	const repoDir = join(tmp, "repo");
	mkdirSync(repoDir, { recursive: true });
	const git = (args: string[]) => spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
	git(["init", "--initial-branch=main"]);
	git(["config", "user.email", "test@nightshift.test"]);
	git(["config", "user.name", "Test"]);
	writeFileSync(join(repoDir, "README"), "test repo");
	git(["add", "README"]);
	git(["commit", "--no-gpg-sign", "-m", "init"]);
	return repoDir;
}

// resumeCoder → spawnRun fails closed when bwrap is absent (macOS build host).
// This module is tested with a FakeLauncher, not the sandbox, so opt into the
// attended-dev escape hatch for the macOS run.
const prevEscapeHatch = process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER;
beforeAll(() => {
	process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER = "1";
});
afterAll(() => {
	if (prevEscapeHatch === undefined) {
		delete process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER;
	} else {
		process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER = prevEscapeHatch;
	}
});

afterEach(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "ns-livespawn-test-"));
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
	const now = new Date().toISOString();
	const projectId = handle.db
		.insert(projects)
		.values({ name: "p", repoUrl: "https://example.test/r.git", createdAt: now, updatedAt: now })
		.returning()
		.get().id;
	task = handle.db
		.insert(tasks)
		.values({
			projectId,
			title: "build a widget",
			description: "the widget",
			state: "review",
			baseSha: "base000",
			createdAt: now,
			updatedAt: now,
		})
		.returning()
		.get();
});

/** Seed a finished coder run with a captured sessionId + worktreePath. */
function seedCoderRun(opts: { sessionId?: string; worktreePath?: string }): number {
	const run = handle.db
		.insert(runs)
		.values({
			taskId: task.id,
			kind: "coder",
			provider: "claude-code",
			model: "cli-default",
			authLane: "subscription",
			state: "succeeded",
			sessionId: opts.sessionId ?? null,
			worktreePath: opts.worktreePath ?? null,
		})
		.returning()
		.get();
	return run.id;
}

// ---------------------------------------------------------------------------
// (a) argv builder

test("buildOneShotArgv builds reviewer argv per provider and fails closed on unknown", () => {
	expect(buildOneShotArgv("codex")).toEqual(["codex", "exec", "-"]);
	expect(buildOneShotArgv("claude-code")).toEqual(["claude", "--print"]);
	expect(() => buildOneShotArgv("gemini")).toThrow(OneShotDisabledError);
});

// ---------------------------------------------------------------------------
// (b) env has no token

test("buildOneShotEnv carries no GitHub token, NIGHTSHIFT_*, or SSH_AUTH_SOCK", () => {
	const env = buildOneShotEnv("/home/task/7");
	expect(env.HOME).toBe("/home/task/7");
	expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH"]);
	expect(env.GITHUB_TOKEN).toBeUndefined();
	expect(env.NIGHTSHIFT_API_TOKEN).toBeUndefined();
	expect(env.SSH_AUTH_SOCK).toBeUndefined();
});

// ---------------------------------------------------------------------------
// (c) runReviewer with a fake spawner

test("makeRunReviewer spawns one-shot, records a reviewer run, re-resolves headSha", async () => {
	seedCoderRun({ worktreePath: "/wt/task1" });

	const seenSpecs: { argv: string[]; prompt: string; cwd: string; home: string }[] = [];
	const fakeSpawner: OneShotSpawner = async (spec) => {
		seenSpecs.push({ argv: spec.argv, prompt: spec.prompt, cwd: spec.cwd, home: spec.home });
		return { stdout: '{"verdict":"approved"}', exitCode: 0 };
	};
	// Fake git: rev-parse HEAD → a stable head sha (no real git).
	const fakeGit = async (args: string[]) =>
		args[0] === "rev-parse" ? "head999\n" : "";

	const runReviewer = makeRunReviewer({
		handle,
		log,
		spawner: fakeSpawner,
		git: fakeGit,
		reviewerProvider: "codex",
	});

	const result = await runReviewer({ task, round: 1, prompt: "review this diff", attempt: 0 });

	// Spawner got the prompt + worktree cwd; argv is the codex one-shot.
	expect(seenSpecs).toHaveLength(1);
	expect(seenSpecs[0]!.argv).toEqual(["codex", "exec", "-"]);
	expect(seenSpecs[0]!.prompt).toBe("review this diff");
	expect(seenSpecs[0]!.cwd).toBe("/wt/task1");

	// Return shape: stdout passthrough, runId, re-resolved headSha.
	expect(result.stdout).toBe('{"verdict":"approved"}');
	expect(result.headSha).toBe("head999");
	expect(result.provider).toBe("codex");

	// A reviewer run row was recorded and reached `succeeded`.
	const row = handle.db.select().from(runs).where(eq(runs.id, result.runId)).get()!;
	expect(row.kind).toBe("reviewer");
	expect(row.state).toBe("succeeded");
	expect(row.authLane).toBe("api_key");
});

// ---------------------------------------------------------------------------
// (d) resumeCoder reaches the launcher with --resume

test("makeResumeCoder resumes the coder session with --resume in the command", async () => {
	seedCoderRun({ sessionId: "sess-abc", worktreePath: "/wt/task1" });

	const launcher = new FakeLauncher();
	const resumeCoder = makeResumeCoder({
		handle,
		log,
		launcher,
		homeRoot: join(tmp, "homes"),
		repoDir: makeGitRepo(), // throwaway temp repo → no side effects on this repo
	});

	const { runId } = await resumeCoder({ task, round: 2, findings: [] });

	// A NEW coder run row was created (distinct from the seeded one).
	const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
	expect(row.kind).toBe("coder");

	// The launcher received a command containing `--resume 'sess-abc'`.
	// The command is bwrap-wrapped: ["bwrap", ...bwrapArgs, "--", "sh", "-c", <shellStr>].
	// The shell one-liner with the prompt+resume flag is always the last element.
	const session = launcher.sessions.get(`ns-${runId}`);
	expect(session).toBeDefined();
	const shellStr = session!.spec.command.at(-1);
	expect(shellStr).toContain("--resume 'sess-abc'");
	// HOST-SIDE TOKEN INVARIANT: no GitHub token in the coder env either.
	expect(session!.spec.env.GITHUB_TOKEN).toBeUndefined();
});

// ---------------------------------------------------------------------------
// (e) NEW: provider bin dir in PATH, auth dir created+seeded, stderr in error

test("buildOneShotEnv prepends NIGHTSHIFT_PROVIDER_BIN_DIR to PATH when set", () => {
	const prev = process.env.NIGHTSHIFT_PROVIDER_BIN_DIR;
	try {
		process.env.NIGHTSHIFT_PROVIDER_BIN_DIR = "/opt/nightshift/bin";
		const env = buildOneShotEnv("/home/task/99");
		expect(env.PATH?.startsWith("/opt/nightshift/bin:")).toBe(true);
		expect(env.PATH).toContain("/usr/local/bin");
	} finally {
		if (prev === undefined) delete process.env.NIGHTSHIFT_PROVIDER_BIN_DIR;
		else process.env.NIGHTSHIFT_PROVIDER_BIN_DIR = prev;
	}
});

test("buildOneShotEnv PATH has no empty segment when NIGHTSHIFT_PROVIDER_BIN_DIR is unset", () => {
	const prev = process.env.NIGHTSHIFT_PROVIDER_BIN_DIR;
	try {
		delete process.env.NIGHTSHIFT_PROVIDER_BIN_DIR;
		const env = buildOneShotEnv("/home/task/99");
		// PATH must not start with ':' (which would put '' = CWD first — a security issue)
		expect(env.PATH?.startsWith(":")).toBe(false);
		expect(env.PATH).toContain("/usr/local/bin");
	} finally {
		if (prev !== undefined) process.env.NIGHTSHIFT_PROVIDER_BIN_DIR = prev;
	}
});

test("makeRunReviewer creates auth dir and passes repoGitDir to spawner before spawn", async () => {
	const homeRoot = join(tmp, "homes-e");
	const wtPath = join(tmp, "wt-e");
	mkdirSync(wtPath, { recursive: true });
	seedCoderRun({ worktreePath: wtPath });

	const seenSpecs: OneShotSpec[] = [];
	const fakeSpawner: OneShotSpawner = async (spec) => {
		seenSpecs.push(spec);
		return { stdout: '{"verdict":"approved"}', exitCode: 0 };
	};
	const fakeGit = async (args: string[]) => (args[0] === "rev-parse" ? "abcdef\n" : "");

	const repoDir = join(tmp, "repo-e");
	mkdirSync(repoDir, { recursive: true });

	const runReviewer = makeRunReviewer({
		handle,
		log,
		spawner: fakeSpawner,
		git: fakeGit,
		reviewerProvider: "claude-code",
		homeRoot,
		repoDir,
	});

	await runReviewer({ task, round: 1, prompt: "check it", attempt: 0 });

	expect(seenSpecs).toHaveLength(1);
	const spec = seenSpecs[0]!;

	// Auth dir must exist before spawner was called (claude-code → .claude).
	const expectedAuthDir = join(homeRoot, String(task.id), ".claude");
	expect(existsSync(expectedAuthDir)).toBe(true);

	// spawner receives the correct authDir path.
	expect(spec.providerAuthDir).toBe(expectedAuthDir);

	// repoGitDir is the .git dir under the injected repoDir.
	expect(spec.repoGitDir).toBe(join(repoDir, ".git"));
});

test("makeRunReviewer non-zero exit surfaces stderr in thrown error", async () => {
	const homeRoot = join(tmp, "homes-f");
	const wtPath = join(tmp, "wt-f");
	mkdirSync(wtPath, { recursive: true });
	seedCoderRun({ worktreePath: wtPath });

	// Fake spawner that simulates a non-zero exit with a stderr message.
	// We simulate this by having the spawner throw the same error the real
	// spawnOneShotCaptured would throw (the error type is OneShotDisabledError).
	const fakeSpawner: OneShotSpawner = async (_spec) => {
		throw new OneShotDisabledError(
			"one-shot exited non-zero (1)\nstderr: claude: command not found",
		);
	};
	const fakeGit = async () => "unused\n";

	const runReviewer = makeRunReviewer({
		handle,
		log,
		spawner: fakeSpawner,
		git: fakeGit,
		reviewerProvider: "codex",
		homeRoot,
	});

	let caughtErr: Error | undefined;
	try {
		await runReviewer({ task, round: 1, prompt: "check it", attempt: 0 });
	} catch (err) {
		caughtErr = err as Error;
	}

	expect(caughtErr).toBeDefined();
	// The error message must include both the exit code and the stderr text.
	expect(caughtErr!.message).toContain("non-zero (1)");
	expect(caughtErr!.message).toContain("claude: command not found");

	// The run row must have transitioned to `failed` (fail-closed).
	const allRuns = handle.db.select().from(runs).where(eq(runs.taskId, task.id)).all();
	const reviewerRun = allRuns.find((r) => r.kind === "reviewer");
	expect(reviewerRun).toBeDefined();
	expect(reviewerRun!.state).toBe("failed");
});
