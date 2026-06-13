/**
 * Tests for runHarnessReviewRound (§3.4 specialist-harness review path).
 *
 * Coverage (6 test cases):
 *   1. Task not in review → {ok:false}
 *   2. All finders empty → block → revise → resume coder
 *   3. Revise at max rounds → escalate needs_human
 *   4. Producer throws → escalate needs_human (fail-closed)
 *   5. makeProduceFinder (liveSpawn) happy path with spawner
 *   6. makeProduceFinder spawn failure → "" (fail-soft)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects, tasks, runs } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { threadApi } from "../thread/thread.ts";
import { runHarnessReviewRound, type HarnessReviewDeps } from "./harnessReview.ts";
import { makeProduceFinder, type LiveDeps } from "../runs/liveSpawn.ts";

let handle: DbHandle;
let log: EventLog;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
});

afterEach(() => {
	handle.sqlite.close();
});

/**
 * Helper: insert a test project.
 */
function insertTestProject(): number {
	const id = Math.floor(Math.random() * 1e6);
	handle.db
		.insert(projects)
		.values({
			id,
			name: `test-project-${id}`,
			repoUrl: "https://github.com/test/repo",
			defaultBranch: "main",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.run();
	return id;
}

/**
 * Helper: insert a test task in the given state.
 */
function insertTestTask(projectId: number, state: string = "review"): number {
	const id = Math.floor(Math.random() * 1e6);
	handle.db
		.insert(tasks)
		.values({
			id,
			projectId,
			title: `Test task ${id}`,
			state,
			priority: 0,
			riskTier: "full",
			round: 0,
			baseSha: "abc123",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		} as typeof tasks.$inferInsert)
		.run();
	return id;
}

/**
 * Helper: insert a coder run for a task (needed for getDiff to find worktree).
 */
function insertCoderRun(taskId: number): number {
	const id = Math.floor(Math.random() * 1e6);
	handle.db
		.insert(runs)
		.values({
			id,
			taskId,
			kind: "coder",
			provider: "claude-code",
			model: "cli-default",
			authLane: "subscription",
			worktreePath: "/tmp/test-worktree",
			state: "running",
			createdAt: new Date().toISOString(),
		} as typeof runs.$inferInsert)
		.run();
	return id;
}

describe("runHarnessReviewRound", () => {
	test("task not in review → {ok:false}", async () => {
		const projectId = insertTestProject();
		const taskId = insertTestTask(projectId, "backlog");

		const deps: HarnessReviewDeps = {
			handle,
			log,
			thread: threadApi,
			engine: async () =>
				({ ok: true, verdict: { verdict: "approved", summary: "", findings: [] } }) as any,
			judge: {} as any,
			runReviewer: async () =>
				({ stdout: "", runId: 0, headSha: "", provider: "x" }) as any,
			getDiff: async () => ({
				diff: "diff --git a/x b/x\n+line",
				headSha: "abc123",
				prTitle: "t",
				prBody: "b",
			}),
			resumeCoder: async () => ({ runId: 0 }),
			maxRounds: 3,
			makeProduceFinder: () => async () => "",
		};

		const result = await runHarnessReviewRound(deps, taskId);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toMatch(/not in review/);
	});

	test("all finders empty → block → revise → resume coder", async () => {
		const projectId = insertTestProject();
		const taskId = insertTestTask(projectId, "review");
		insertCoderRun(taskId);

		const resumedCalls: any[] = [];

		const deps: HarnessReviewDeps = {
			handle,
			log,
			thread: threadApi,
			engine: async () =>
				({ ok: true, verdict: { verdict: "approved", summary: "", findings: [] } }) as any,
			judge: {} as any,
			runReviewer: async () =>
				({ stdout: "", runId: 0, headSha: "", provider: "x" }) as any,
			getDiff: async () => ({
				diff: "diff --git a/x b/x\n+line",
				headSha: "abc123",
				prTitle: "t",
				prBody: "b",
			}),
			resumeCoder: async (input) => {
				resumedCalls.push(input);
				return { runId: 0 };
			},
			maxRounds: 3,
			makeProduceFinder: () => async () => "", // empty stdout from all finders
		};

		const result = await runHarnessReviewRound(deps, taskId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.outcome).toBe("revise");
		expect(result.round).toBe(1);
		expect(resumedCalls.length).toBe(1);

		// Task should be in coding state now
		const updatedTask = handle.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
		expect(updatedTask?.state).toBe("coding");
	});

	test("revise at max rounds → escalate needs_human", async () => {
		const projectId = insertTestProject();
		const taskId = insertTestTask(projectId, "review");
		insertCoderRun(taskId);

		// Bump the task to round 3, maxRounds 3, so next would be 4 (not < 3)
		handle.db
			.update(tasks)
			.set({ round: 3, updatedAt: new Date().toISOString() })
			.where(eq(tasks.id, taskId))
			.run();

		const resumedCalls: any[] = [];

		const deps: HarnessReviewDeps = {
			handle,
			log,
			thread: threadApi,
			engine: async () =>
				({ ok: true, verdict: { verdict: "approved", summary: "", findings: [] } }) as any,
			judge: {} as any,
			runReviewer: async () =>
				({ stdout: "", runId: 0, headSha: "", provider: "x" }) as any,
			getDiff: async () => ({
				diff: "diff --git a/x b/x\n+line",
				headSha: "abc123",
				prTitle: "t",
				prBody: "b",
			}),
			resumeCoder: async (input) => {
				resumedCalls.push(input);
				return { runId: 0 };
			},
			maxRounds: 3,
			makeProduceFinder: () => async () => "",
		};

		const result = await runHarnessReviewRound(deps, taskId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.outcome).toBe("needs_human");
		expect(result.round).toBe(4);
		expect(resumedCalls.length).toBe(0); // resumeCoder should NOT be called

		// Task should be in needs_human state
		const updatedTask = handle.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
		expect(updatedTask?.state).toBe("needs_human");
	});

	test("producer throws → escalate needs_human (fail-closed)", async () => {
		const projectId = insertTestProject();
		const taskId = insertTestTask(projectId, "review");
		insertCoderRun(taskId);

		const deps: HarnessReviewDeps = {
			handle,
			log,
			thread: threadApi,
			engine: async () =>
				({ ok: true, verdict: { verdict: "approved", summary: "", findings: [] } }) as any,
			judge: {} as any,
			runReviewer: async () =>
				({ stdout: "", runId: 0, headSha: "", provider: "x" }) as any,
			getDiff: async () => ({
				diff: "diff --git a/x b/x\n+line",
				headSha: "abc123",
				prTitle: "t",
				prBody: "b",
			}),
			resumeCoder: async () => ({ runId: 0 }),
			maxRounds: 3,
			makeProduceFinder: () => async () => {
				throw new Error("spawn boom");
			},
		};

		const result = await runHarnessReviewRound(deps, taskId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.outcome).toBe("needs_human");

		// Task should be in needs_human state
		const updatedTask = handle.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
		expect(updatedTask?.state).toBe("needs_human");
	});

	test("makeProduceFinder (liveSpawn) happy path with spawner", async () => {
		const projectId = insertTestProject();
		const taskId = insertTestTask(projectId, "review");
		const runId = insertCoderRun(taskId);

		const spawnerCalls: any[] = [];

		const liveDeps: LiveDeps = {
			handle,
			log,
			reviewerProvider: "codex",
			homeRoot: "/tmp",
			spawner: async (spec) => {
				spawnerCalls.push(spec);
				return { stdout: "FINDER OUTPUT", exitCode: 0 };
			},
		};

		const task = handle.db
			.select()
			.from(tasks)
			.where(eq(tasks.id, taskId))
			.get()!;

		const produceFinder = makeProduceFinder(liveDeps, task);
		const output = await produceFinder("security", "check this");

		expect(output).toBe("FINDER OUTPUT");
		expect(spawnerCalls.length).toBe(1);
		expect(spawnerCalls[0].cwd).toBe("/tmp/test-worktree");
		expect(spawnerCalls[0].prompt).toBe("check this");
		expect(spawnerCalls[0].home).toBe(`/tmp/${taskId}`);
	});

	test("makeProduceFinder spawn failure → '' (fail-soft)", async () => {
		const projectId = insertTestProject();
		const taskId = insertTestTask(projectId, "review");
		insertCoderRun(taskId);

		const liveDeps: LiveDeps = {
			handle,
			log,
			reviewerProvider: "codex",
			homeRoot: "/tmp",
			spawner: async () => {
				throw new Error("nope");
			},
		};

		const task = handle.db
			.select()
			.from(tasks)
			.where(eq(tasks.id, taskId))
			.get()!;

		const produceFinder = makeProduceFinder(liveDeps, task);
		const output = await produceFinder("security", "check this");

		// Fail-soft: returns empty string, doesn't throw
		expect(output).toBe("");
	});
});
