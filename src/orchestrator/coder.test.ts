/**
 * WHY: Hermetic integration tests for the coder orchestrator loop. Uses
 * in-memory SQLite + fake ForgeClient/Pusher/CiClient + a real tmpdir git
 * repo so the diff/headSha resolution works without network or credentials.
 *
 * Coverage:
 *   - clean diff + fresh branch → outcome "review", pusher + client called,
 *     task in review, task.pr_opened event written.
 *   - diff containing a planted secret → outcome "needs_human", task
 *     needs_human, pusher/client NOT called.
 *   - red CI (required check failing) → outcome "needs_human", task
 *     needs_human.
 *   - run in failed state → outcome "failed", task failed.
 *   - confirmMergeAndUnblock: task A merging→done, dependent B
 *     backlog→ready via recomputeReadiness.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects, runs, tasks } from "../db/schema.ts";
import type { RunRow } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { execGit } from "../worktree/git.ts";
import { addDependency } from "../tasks/dependencies.ts";
import { getTask } from "../tasks/tasks.ts";
import { transitionTask } from "../tasks/transitions.ts";
import type { ForgeClient, ForgeClientRequest, ForgeClientResponse } from "../forge/github.ts";
import type { Pusher } from "../forge/push.ts";
import type { CiClient, CheckRun } from "../gate/ci.ts";
import type { GitRunner } from "../gate/freshness.ts";
import {
	completeCoderRun,
	confirmMergeAndUnblock,
	startCoderTask,
	type CoderOrchestratorDeps,
	type RepoConfig,
} from "./coder.ts";
import { FakeLauncher } from "../runs/launcher.ts";
import type { NightshiftConfig } from "../config/config.ts";
import { EgressInactiveError } from "../egress/guard.ts";

// ---------------------------------------------------------------------------
// Helpers — git repo setup
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "ns-orch-"));
}

/**
 * Initialise a git repo, commit a base commit, add a feature commit on top,
 * and return { repoDir, baseSha, headSha }. The repo is used directly as
 * both repoDir and worktreePath in tests (not a real worktree, but the git
 * commands that matter — rev-parse HEAD and diff — work fine).
 */
async function initRepoWithFeatureCommit(dir: string): Promise<{
	repoDir: string;
	baseSha: string;
	headSha: string;
}> {
	await execGit(["init"], dir);
	await execGit(["config", "user.email", "test@nightshift.local"], dir);
	await execGit(["config", "user.name", "Test"], dir);

	// Base commit (this becomes the task's baseSha).
	writeFileSync(join(dir, "README.md"), "# test\n");
	await execGit(["add", "."], dir);
	await execGit(["commit", "-m", "init"], dir);
	const baseSha = (await execGit(["rev-parse", "HEAD"], dir)).trim();

	// Feature commit (the "coder output").
	writeFileSync(join(dir, "feature.ts"), "export const x = 1;\n");
	await execGit(["add", "."], dir);
	await execGit(["commit", "-m", "feat: add feature"], dir);
	const headSha = (await execGit(["rev-parse", "HEAD"], dir)).trim();

	return { repoDir: dir, baseSha, headSha };
}

// ---------------------------------------------------------------------------
// Helpers — fakes
// ---------------------------------------------------------------------------

function makeFakePusher(): { pusher: Pusher; wasCalled: () => boolean } {
	let called = false;
	const pusher: Pusher = async (_args, _cwd, _env) => {
		called = true;
		return "";
	};
	return { pusher, wasCalled: () => called };
}

function makeFakeForgeClient(
	prNumber = 99,
	prUrl = "https://github.com/o/r/pull/99",
): { client: ForgeClient; wasCalled: () => boolean } {
	let called = false;
	const client: ForgeClient = {
		async request(_req: ForgeClientRequest): Promise<ForgeClientResponse> {
			called = true;
			return { status: 201, json: { number: prNumber, html_url: prUrl } };
		},
	};
	return { client, wasCalled: () => called };
}

/**
 * A CiClient whose fetchChecks always returns the supplied check list.
 */
function makeFakeCiClient(checks: CheckRun[]): CiClient {
	return {
		async fetchChecks(_ref: string): Promise<CheckRun[]> {
			return checks;
		},
	};
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let handle: DbHandle;
let log: EventLog;
let projectId: number;
let repoDir: string;
let baseSha: string;
let headSha: string;

beforeEach(async () => {
	// In-memory DB.
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);

	// Seed project.
	const now = new Date().toISOString();
	projectId = handle.db
		.insert(projects)
		.values({
			name: "test-project",
			repoUrl: "https://github.com/o/r.git",
			createdAt: now,
			updatedAt: now,
		})
		.returning()
		.get().id;

	// Real git repo with a feature commit.
	repoDir = makeTmpDir();
	({ baseSha, headSha } = await initRepoWithFeatureCommit(repoDir));
});

afterEach(() => {
	try {
		rmSync(repoDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

// ---------------------------------------------------------------------------
// Helpers — seed DB state
// ---------------------------------------------------------------------------

/**
 * Seed a task directly in `coding` state with baseSha and branch recorded,
 * plus a run in the given state. Returns { taskId, runId }.
 */
function seedCodingTaskWithRun(
	runState: "succeeded" | "failed",
	opts: { taskBaseSha?: string; branch?: string } = {},
): { taskId: number; runId: number } {
	const now = new Date().toISOString();

	const taskId = handle.db
		.insert(tasks)
		.values({
			projectId,
			title: "test task",
			state: "coding",
			priority: 0,
			baseSha: opts.taskBaseSha ?? baseSha,
			branch: opts.branch ?? "ns/test-feature-abc123",
			createdAt: now,
			updatedAt: now,
		})
		.returning()
		.get().id;

	const runId = handle.db
		.insert(runs)
		.values({
			taskId,
			kind: "coder",
			provider: "claude-code",
			model: "claude-sonnet-4-5",
			authLane: "subscription",
			state: runState,
			worktreePath: repoDir,
		})
		.returning()
		.get().id;

	return { taskId, runId };
}

/**
 * Build a CoderOrchestratorDeps with the given overrides.
 */
function makeDeps(overrides: Partial<CoderOrchestratorDeps> & {
	pusher?: Pusher;
	forgeClient: ForgeClient;
	ci?: CiClient;
	git?: GitRunner;
}): CoderOrchestratorDeps {
	return {
		handle,
		log,
		forgeClient: overrides.forgeClient,
		pusher: overrides.pusher,
		ci: overrides.ci,
		git: overrides.git,
		resolveRepo: (_task, _run): RepoConfig => ({
			repoDir,
			worktreePath: repoDir,
			remoteUrl: "https://github.com/o/r.git",
			owner: "o",
			repo: "r",
			defaultBranch: "main",
			requiredChecks: overrides.ci !== undefined ? ["ci"] : undefined,
		}),
	};
}

// ---------------------------------------------------------------------------
// Test 1: clean diff + fresh branch → review
// ---------------------------------------------------------------------------

describe("completeCoderRun", () => {
	test("clean diff + fresh branch → outcome review, task in review, event written", async () => {
		const { taskId, runId } = seedCodingTaskWithRun("succeeded");

		const { pusher, wasCalled: pusherCalled } = makeFakePusher();
		const { client, wasCalled: clientCalled } = makeFakeForgeClient(42, "https://github.com/o/r/pull/42");

		// Use a fake git runner that returns baseSha for both rev-parse and
		// merge-base checks (making the branch "fresh"), and the feature diff.
		// We use the real execGit for worktree HEAD resolution but need to
		// simulate freshness by having baseSha === main HEAD.
		// The simplest approach: the real repo has "main" as the default branch
		// and our baseSha IS the HEAD of main (since we haven't advanced main).
		// The gate checks `git rev-parse main` which resolves to the initial
		// commit (baseSha), so the branch IS fresh.

		// However, git init uses "master" by default on older git versions and
		// "main" on newer ones. To avoid this ambiguity, we configure a fake
		// git runner for the gate calls and use real execGit only for HEAD.

		// Use a fake GitRunner that makes the branch look fresh.
		const fakeGit: GitRunner = async (args, cwd) => {
			const cmd = args[0] ?? "";
			// rev-parse HEAD → return actual headSha.
			if (cmd === "rev-parse" && args[1] === "HEAD") {
				return headSha + "\n";
			}
			// rev-parse main → return baseSha (so branch is fresh: baseSha === main HEAD).
			if (cmd === "rev-parse") {
				return baseSha + "\n";
			}
			// cat-file -e <sha> → success (sha is valid).
			if (cmd === "cat-file") {
				return "";
			}
			// diff baseSha..HEAD → clean diff.
			if (cmd === "diff") {
				return "+const x = 1;\n";
			}
			// merge-base --is-ancestor → throw (not needed if fresh).
			if (cmd === "merge-base") {
				throw new Error("not ancestor");
			}
			// Fallback to real git for anything else.
			return execGit(args, cwd);
		};

		const deps = makeDeps({ pusher, forgeClient: client, git: fakeGit });
		const result = await completeCoderRun(deps, runId);

		expect(result.outcome).toBe("review");
		if (result.outcome === "review") {
			expect(result.pr.number).toBe(42);
			expect(result.pr.url).toBe("https://github.com/o/r/pull/42");
		}

		// Pusher and client WERE called.
		expect(pusherCalled()).toBe(true);
		expect(clientCalled()).toBe(true);

		// Task is in review.
		const task = getTask(handle, taskId);
		expect(task?.state).toBe("review");

		// task.pr_opened event was written.
		const evRows = handle.db
			.select()
			.from(
				// events table
				(await import("../db/schema.ts")).events,
			)
			.all()
			.filter((e) => e.kind === "task.pr_opened" && e.taskId === taskId);
		expect(evRows.length).toBeGreaterThanOrEqual(1);
	});

	// ---------------------------------------------------------------------------
	// Test 2: planted secret → needs_human, pusher/client NOT called
	// ---------------------------------------------------------------------------

	test("diff with planted secret → needs_human, pusher/client NOT called", async () => {
		const { taskId, runId } = seedCodingTaskWithRun("succeeded");

		const { pusher, wasCalled: pusherCalled } = makeFakePusher();
		const { client, wasCalled: clientCalled } = makeFakeForgeClient();

		// The secret line triggers the secret scanner inside prepareAndOpenPR.
		const secretLine = "+const t = \"" + "ghp_" + "0123456789012345678901234567890123456\";";

		const fakeGit: GitRunner = async (args, _cwd) => {
			const cmd = args[0] ?? "";
			if (cmd === "rev-parse" && args[1] === "HEAD") return headSha + "\n";
			if (cmd === "rev-parse") return baseSha + "\n";
			if (cmd === "cat-file") return "";
			if (cmd === "diff") return secretLine + "\n";
			if (cmd === "merge-base") throw new Error("not ancestor");
			return "";
		};

		const deps = makeDeps({ pusher, forgeClient: client, git: fakeGit });
		const result = await completeCoderRun(deps, runId);

		expect(result.outcome).toBe("needs_human");

		// Pusher and client must NOT have been called.
		expect(pusherCalled()).toBe(false);
		expect(clientCalled()).toBe(false);

		// Task is in needs_human.
		const task = getTask(handle, taskId);
		expect(task?.state).toBe("needs_human");
	});

	// ---------------------------------------------------------------------------
	// Test 3: red CI → needs_human
	// ---------------------------------------------------------------------------

	test("red CI (required check failing) → needs_human", async () => {
		const { taskId, runId } = seedCodingTaskWithRun("succeeded");

		const { pusher, wasCalled: pusherCalled } = makeFakePusher();
		const { client, wasCalled: clientCalled } = makeFakeForgeClient();

		// CI client returns the required check "ci" as failing.
		const ciClient = makeFakeCiClient([{ name: "ci", status: "failure" }]);

		const fakeGit: GitRunner = async (args, _cwd) => {
			const cmd = args[0] ?? "";
			if (cmd === "rev-parse" && args[1] === "HEAD") return headSha + "\n";
			if (cmd === "rev-parse") return baseSha + "\n";
			if (cmd === "cat-file") return "";
			if (cmd === "diff") return "+const x = 1;\n";
			if (cmd === "merge-base") throw new Error("not ancestor");
			return "";
		};

		// resolveRepo includes requiredChecks so CI is evaluated.
		const deps: CoderOrchestratorDeps = {
			handle,
			log,
			forgeClient: client,
			pusher,
			ci: ciClient,
			git: fakeGit,
			resolveRepo: (_task, _run): RepoConfig => ({
				repoDir,
				worktreePath: repoDir,
				remoteUrl: "https://github.com/o/r.git",
				owner: "o",
				repo: "r",
				defaultBranch: "main",
				requiredChecks: ["ci"],
			}),
		};

		const result = await completeCoderRun(deps, runId);

		expect(result.outcome).toBe("needs_human");
		if (result.outcome === "needs_human") {
			expect(result.blocked.some((b) => b.includes("ci"))).toBe(true);
		}

		expect(pusherCalled()).toBe(false);
		expect(clientCalled()).toBe(false);

		const task = getTask(handle, taskId);
		expect(task?.state).toBe("needs_human");
	});

	// ---------------------------------------------------------------------------
	// Test 4: run in failed state → outcome failed, task failed
	// ---------------------------------------------------------------------------

	test("run in failed state → outcome failed, task transitioned to failed", async () => {
		const { taskId, runId } = seedCodingTaskWithRun("failed");

		const { client } = makeFakeForgeClient();
		const { pusher } = makeFakePusher();

		const deps = makeDeps({
			pusher,
			forgeClient: client,
			git: async (args, _cwd) => {
				const cmd = args[0] ?? "";
				if (cmd === "rev-parse") return baseSha + "\n";
				return "";
			},
		});

		const result = await completeCoderRun(deps, runId);

		expect(result.outcome).toBe("failed");
		if (result.outcome === "failed") {
			expect(result.reason).toBe("coder run failed");
		}

		const task = getTask(handle, taskId);
		expect(task?.state).toBe("failed");
	});
});

// ---------------------------------------------------------------------------
// Test 5: confirmMergeAndUnblock — A done, B promoted backlog→ready
// ---------------------------------------------------------------------------

describe("confirmMergeAndUnblock", () => {
	test("merging task A done + dependent B promoted backlog→ready", async () => {
		const now = new Date().toISOString();

		// Task A: seed directly in merging state.
		const taskAId = handle.db
			.insert(tasks)
			.values({
				projectId,
				title: "task A",
				state: "merging",
				priority: 0,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get().id;

		// Task B: in backlog, depends on A.
		const taskBId = handle.db
			.insert(tasks)
			.values({
				projectId,
				title: "task B",
				state: "backlog",
				priority: 1,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get().id;

		// Add dependency: B depends on A.
		await addDependency(handle, taskBId, taskAId);

		// Confirm merge for A.
		const result = await confirmMergeAndUnblock(
			{ handle, log },
			taskAId,
			"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		);

		expect(result.ok).toBe(true);
		expect(result.unblocked).toContain(taskBId);

		// Task A is done with the merge SHA.
		const taskA = getTask(handle, taskAId);
		expect(taskA?.state).toBe("done");
		expect(taskA?.mergeSha).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

		// Task B is now ready.
		const taskB = getTask(handle, taskBId);
		expect(taskB?.state).toBe("ready");
	});

	test("task not in merging returns ok:false", async () => {
		const now = new Date().toISOString();
		const taskId = handle.db
			.insert(tasks)
			.values({
				projectId,
				title: "task in review",
				state: "review",
				priority: 0,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get().id;

		const result = await confirmMergeAndUnblock(
			{ handle, log },
			taskId,
			"deadbeef",
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/not in merging/);
		expect(result.unblocked).toHaveLength(0);
	});

	test("non-existent task returns ok:false", async () => {
		const result = await confirmMergeAndUnblock(
			{ handle, log },
			999_999,
			"deadbeef",
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/not found/);
		expect(result.unblocked).toHaveLength(0);
	});

	test("task A done but B has a second unmerged dep — B stays in backlog", async () => {
		const now = new Date().toISOString();

		// Task A (will be merged).
		const taskAId = handle.db
			.insert(tasks)
			.values({
				projectId,
				title: "task A",
				state: "merging",
				priority: 0,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get().id;

		// Task C (NOT merged — also a dep of B).
		const taskCId = handle.db
			.insert(tasks)
			.values({
				projectId,
				title: "task C",
				state: "coding",
				priority: 2,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get().id;

		// Task B: depends on both A and C.
		const taskBId = handle.db
			.insert(tasks)
			.values({
				projectId,
				title: "task B",
				state: "backlog",
				priority: 3,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get().id;

		await addDependency(handle, taskBId, taskAId);
		await addDependency(handle, taskBId, taskCId);

		const result = await confirmMergeAndUnblock(
			{ handle, log },
			taskAId,
			"aabbccddeeff00112233445566778899aabbccdd",
		);

		expect(result.ok).toBe(true);
		// B must NOT be in unblocked — C is still unmerged.
		expect(result.unblocked).not.toContain(taskBId);

		// Task B stays in backlog.
		const taskB = getTask(handle, taskBId);
		expect(taskB?.state).toBe("backlog");
	});
});

// ---------------------------------------------------------------------------
// Edge: completeCoderRun with no baseSha → needs_human
// ---------------------------------------------------------------------------

describe("completeCoderRun edge cases", () => {
	test("task with no baseSha → needs_human [no base SHA recorded]", async () => {
		const now = new Date().toISOString();

		// Task in coding, but no baseSha.
		const taskId = handle.db
			.insert(tasks)
			.values({
				projectId,
				title: "no base sha",
				state: "coding",
				priority: 0,
				baseSha: null,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get().id;

		const runId = handle.db
			.insert(runs)
			.values({
				taskId,
				kind: "coder",
				provider: "claude-code",
				model: "m",
				authLane: "local",
				state: "succeeded",
				worktreePath: repoDir,
			})
			.returning()
			.get().id;

		const { client } = makeFakeForgeClient();
		const { pusher } = makeFakePusher();

		const fakeGit: GitRunner = async (args, _cwd) => {
			if (args[0] === "rev-parse") return baseSha + "\n";
			return "";
		};

		const deps = makeDeps({ pusher, forgeClient: client, git: fakeGit });
		const result = await completeCoderRun(deps, runId);

		expect(result.outcome).toBe("needs_human");
		if (result.outcome === "needs_human") {
			expect(result.blocked).toContain("no base SHA recorded");
		}

		const task = getTask(handle, taskId);
		expect(task?.state).toBe("needs_human");
	});

	test("run not found → outcome failed", async () => {
		const { client } = makeFakeForgeClient();
		const deps = makeDeps({ forgeClient: client });
		const result = await completeCoderRun(deps, 999_999);
		expect(result.outcome).toBe("failed");
		if (result.outcome === "failed") {
			expect(result.reason).toBe("run not found");
		}
	});

	test("run not in succeeded (e.g. running) → outcome failed without mutation", async () => {
		const now = new Date().toISOString();
		const taskId = handle.db
			.insert(tasks)
			.values({
				projectId,
				title: "t",
				state: "coding",
				priority: 0,
				baseSha,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get().id;

		const runId = handle.db
			.insert(runs)
			.values({
				taskId,
				kind: "coder",
				provider: "p",
				model: "m",
				authLane: "local",
				state: "running",
			})
			.returning()
			.get().id;

		const { client } = makeFakeForgeClient();
		const deps = makeDeps({ forgeClient: client });
		const result = await completeCoderRun(deps, runId);

		expect(result.outcome).toBe("failed");
		if (result.outcome === "failed") {
			expect(result.reason).toMatch(/not succeeded/);
		}

		// Task must NOT have been mutated.
		const task = getTask(handle, taskId);
		expect(task?.state).toBe("coding");
	});
});

// ---------------------------------------------------------------------------
// startCoderTask — egress fail-closed gate (LIVE-WIRING D5, fail-closed req #2)
// ---------------------------------------------------------------------------

describe("startCoderTask egress gate", () => {
	test("unattended + untrusted + egress inactive → refused before any run is created", async () => {
		const now = new Date().toISOString();
		const taskId = handle.db
			.insert(tasks)
			.values({
				projectId,
				title: "scheduler task",
				state: "ready",
				priority: 0,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get().id;

		const launcher = new FakeLauncher();

		await expect(
			startCoderTask(
				{ handle, log, launcher },
				{
					taskId,
					provider: "claude-code",
					model: "cli-default",
					authLane: "subscription",
					prompt: "do the work",
					repoDir,
					homeRoot: repoDir,
					unattended: true,
					trustedRepo: false,
				},
				// Deterministic probe: egress NOT active (platform-independent).
				{ egressActive: async () => false },
			),
		).rejects.toBeInstanceOf(EgressInactiveError);

		// No run row was created and the task was NOT claimed (still ready).
		const runCount = handle.db.select().from(runs).all().length;
		expect(runCount).toBe(0);
		expect(getTask(handle, taskId)?.state).toBe("ready");
	});

	// Finding 1 (critical): a spawn failure AFTER a successful claim must roll
	// BOTH the run (→ killed) and the task (→ failed) back, or the queued run +
	// coding task become a zombie that permanently occupies a scheduler slot and
	// the provider cap (deadlocking the unattended loop at maxParallelSlots=1).
	// This is the one branch the rest of the suite never exercises, so it gets a
	// single hermetic case (launcher throws — platform-independent).
	test("spawn failure after a successful claim rolls back run→killed AND task→failed", async () => {
		const now = new Date().toISOString();
		const taskId = handle.db
			.insert(tasks)
			.values({
				projectId,
				title: "rollback task",
				state: "ready",
				priority: 0,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get().id;

		// Launcher that throws on launch — deterministic spawn failure on any OS.
		const throwingLauncher: import("../runs/launcher.ts").Launcher = {
			async launch() {
				throw new Error("tmux unavailable");
			},
			async isAlive() {
				return false;
			},
			async kill() {
				// rollback's run→killed may also kill the (never-created) session.
			},
		};

		// Get past the macOS sandbox fail-closed so we reach the launcher branch.
		const prev = process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER;
		process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER = "1";
		let result: Awaited<ReturnType<typeof startCoderTask>>;
		try {
			result = await startCoderTask(
				{ handle, log, launcher: throwingLauncher },
				{
					taskId,
					provider: "claude-code",
					model: "cli-default",
					authLane: "subscription",
					prompt: "do the work",
					repoDir,
					homeRoot: repoDir,
					unattended: false,
				},
				// Egress probe is irrelevant for an attended spawn, but pin it.
				{ egressActive: async () => true },
			);
		} finally {
			if (prev === undefined) delete process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER;
			else process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER = prev;
		}

		// Caller sees a refusal, not a throw.
		expect(result.ok).toBe(false);

		// The claimed task is rolled back to `failed` (so the failed→backlog
		// demote/triage path can requeue it) — NOT stuck in `coding`.
		expect(getTask(handle, taskId)?.state).toBe("failed");

		// The run exists but is TERMINAL (killed), so it occupies neither a
		// scheduler slot nor the provider cap (both count non-terminal runs only).
		const taskRuns = handle.db.select().from(runs).where(eq(runs.taskId, taskId)).all();
		expect(taskRuns).toHaveLength(1);
		expect(taskRuns[0]?.state).toBe("killed");
	});
});

// ---------------------------------------------------------------------------
// startCoderTask — container isolation config threading (TASK 3)
//
// Proves StartCoderTaskInput.containerConfig is threaded through to spawnRun.
// DISABLED (enabled=false) MUST be a pure passthrough to the existing bwrap
// sandbox path — identical launch command to "no containerConfig at all".
// ENABLED routes through makeIsolatedSpawn (the container selector); on a host
// without the runtime it fails closed, proving the config actually reached the
// selector rather than being silently dropped.
// ---------------------------------------------------------------------------

describe("startCoderTask container config threading", () => {
	const disabledContainer: NightshiftConfig["container"] = {
		enabled: false,
		runtime: "docker",
		image: "nightshift:latest",
		network: "none",
		memLimit: "4g",
		cpuLimit: "2",
	};

	function seedReadyTask(): number {
		const now = new Date().toISOString();
		return handle.db
			.insert(tasks)
			.values({
				projectId,
				title: "container task",
				state: "ready",
				priority: 0,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get().id;
	}

	// A launcher that captures the command it was asked to launch.
	function makeCapturingLauncher(): {
		launcher: import("../runs/launcher.ts").Launcher;
		lastCommand: () => string[] | null;
	} {
		let captured: string[] | null = null;
		const launcher: import("../runs/launcher.ts").Launcher = {
			async launch(spec) {
				captured = spec.command;
				return { sessionName: spec.sessionName };
			},
			async isAlive() {
				return true;
			},
			async kill() {
				/* no-op */
			},
		};
		return { launcher, lastCommand: () => captured };
	}

	const prev = process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER;
	beforeEach(() => {
		// Get past the off-Linux bwrap fail-closed so the bwrapFallback returns the
		// bare inner command — making the disabled passthrough deterministic on macOS.
		process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER = "1";
	});
	afterEach(() => {
		if (prev === undefined) delete process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER;
		else process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER = prev;
	});

	test("container DISABLED is a pure passthrough — same launch command as no containerConfig", async () => {
		// Baseline: no containerConfig at all.
		const baselineTaskId = seedReadyTask();
		const baseCap = makeCapturingLauncher();
		const baseResult = await startCoderTask(
			{ handle, log, launcher: baseCap.launcher },
			{
				taskId: baselineTaskId,
				provider: "claude-code",
				model: "cli-default",
				authLane: "subscription",
				prompt: "do the work",
				repoDir,
				homeRoot: repoDir,
				unattended: false,
			},
			{ egressActive: async () => true },
		);
		expect(baseResult.ok).toBe(true);
		const baselineCmd = baseCap.lastCommand();
		expect(baselineCmd).not.toBeNull();

		// With an explicitly DISABLED container config.
		const disabledTaskId = seedReadyTask();
		const disabledCap = makeCapturingLauncher();
		const disabledResult = await startCoderTask(
			{ handle, log, launcher: disabledCap.launcher },
			{
				taskId: disabledTaskId,
				provider: "claude-code",
				model: "cli-default",
				authLane: "subscription",
				prompt: "do the work",
				repoDir,
				homeRoot: repoDir,
				unattended: false,
				containerConfig: disabledContainer,
			},
			{ egressActive: async () => true },
		);
		expect(disabledResult.ok).toBe(true);
		const disabledCmd = disabledCap.lastCommand();
		expect(disabledCmd).not.toBeNull();

		// Pure passthrough: the disabled-container launch command took the EXACT
		// same bwrapFallback branch as the no-containerConfig baseline. The two
		// commands cannot be byte-compared (each run has a random worktree-hash and
		// a runId-derived prompt temp file), so assert the structural invariants:
		//   - same leading token (bwrap on Linux / sh under the macOS escape hatch),
		//   - same token count,
		//   - NO container runtime tokens injected (the container path was inert).
		expect(disabledCmd![0]).toBe(baselineCmd![0]);
		expect(disabledCmd!.length).toBe(baselineCmd!.length);
		// Both wrap the SAME inner coder one-liner (cat+rm+exec prompt-via-file),
		// confirming the disabled path produced the bwrapFallback shape, not a
		// container argv.
		expect(disabledCmd!.join(" ")).toContain("exec");
		expect(baselineCmd!.join(" ")).toContain("exec");
		// No container runtime tokens leaked into the disabled path — it is inert.
		expect(disabledCmd!.join(" ")).not.toContain("docker");
		expect(disabledCmd).not.toContain("--rm");
		expect(disabledCmd).not.toContain("--network");
	});

	test("container ENABLED routes through the container selector (config reaches makeIsolatedSpawn)", async () => {
		const enabledContainer: NightshiftConfig["container"] = {
			...disabledContainer,
			enabled: true,
		};
		const taskId = seedReadyTask();
		const cap = makeCapturingLauncher();

		const result = await startCoderTask(
			{ handle, log, launcher: cap.launcher },
			{
				taskId,
				provider: "claude-code",
				model: "cli-default",
				authLane: "subscription",
				prompt: "do the work",
				repoDir,
				homeRoot: repoDir,
				unattended: false,
				containerConfig: enabledContainer,
			},
			{ egressActive: async () => true },
		);

		const cmd = cap.lastCommand();
		const dockerAvailable =
			process.platform === "linux" && Bun.which("docker") !== null;

		if (dockerAvailable) {
			// Linux host with docker present → the container argv (buildContainerArgv
			// via buildInteractiveContainerArgv) is built and handed to the launcher.
			// That argv begins with the `run --rm` subcommand and carries the
			// container flags + image from the threaded enabledContainer config —
			// proving the config reached makeIsolatedSpawn and the container path was
			// taken (vs. the bare bwrap `sh -c` one-liner the disabled test produced).
			expect(result.ok).toBe(true);
			expect(cmd).not.toBeNull();
			expect(cmd![0]).toBe("run");
			expect(cmd).toContain("--rm");
			expect(cmd).toContain("--network");
			expect(cmd).toContain(enabledContainer.network);
			expect(cmd).toContain(enabledContainer.image);
			// The inner coder one-liner is appended after the image.
			expect(cmd!.join(" ")).toContain("exec");
		} else {
			// No runtime (macOS or Linux without docker) → makeIsolatedSpawn fails
			// closed with ContainerUnavailableError. startCoderTask catches the spawn
			// throw, rolls back, and returns a refusal whose reason names the
			// container — proving the enabled config reached the selector and was NOT
			// silently dropped to the bwrap path (which would have succeeded above).
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason.toLowerCase()).toContain("container");
			}
			// Launcher never received a command (selector threw before launch).
			expect(cmd).toBeNull();
			// Rolled back: task → failed, run → killed (no zombie slot/cap).
			expect(getTask(handle, taskId)?.state).toBe("failed");
		}
	});
});
