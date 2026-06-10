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
	type CoderOrchestratorDeps,
	type RepoConfig,
} from "./coder.ts";

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
