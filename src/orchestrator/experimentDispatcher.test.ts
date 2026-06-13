/**
 * Test suite for experimentDispatcher.ts (hermetic).
 * Cases: routine not found, wrong kind, invalid config, valid config w/ fake deps, createRun spy.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { EventLog } from "../events/events.ts";
import { createRun as realCreateRun } from "../runs/runs.ts";
import { createRoutine } from "../triggers/routines.ts";
import { runs, projects, tasks } from "../db/schema.ts";
import { dispatchExperiment } from "./experimentDispatcher.ts";
import type { ExperimentRunDeps } from "./experimentRun.ts";

describe("dispatchExperiment", () => {
	let handle: ReturnType<typeof openDatabase>;
	let log: EventLog;

	beforeEach(() => {
		handle = openDatabase(":memory:");
		runMigrations(handle);
		log = new EventLog(handle);
	});

	afterEach(() => {
		handle.sqlite.close();
	});

	// Fixture: create a project and task (required for run FK).
	async function setupFixture() {
		const now = new Date().toISOString();
		const project = handle.db
			.insert(projects)
			.values({
				name: "test-project",
				repoUrl: "https://example.com/repo.git",
				defaultBranch: "main",
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get();

		const task = handle.db
			.insert(tasks)
			.values({
				projectId: project.id,
				title: "Test Task",
				state: "draft",
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get();

		return { projectId: project.id, taskId: task.id };
	}

	test("routine not found → result.ok === false, reason matches /not found/", async () => {
		const { taskId } = await setupFixture();
		const result = await dispatchExperiment(
			{ handle, log },
			{ routineId: 99999, taskId, maxIterations: 1 },
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/not found/);
		}
	});

	test("routine kind is 'task', not 'experiment' → result.ok === false", async () => {
		const { projectId, taskId } = await setupFixture();

		const routineRes = await createRoutine(handle, log, {
			projectId,
			name: "TaskRoutine",
			kind: "task",
			promptName: "default",
		});
		expect(routineRes.ok).toBe(true);
		if (!routineRes.ok) return;
		const routineId = routineRes.routine.id;

		const result = await dispatchExperiment(
			{ handle, log },
			{ routineId, taskId, maxIterations: 1 },
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/not an experiment/);
		}
	});

	test("experiment routine with invalid params (null) → run finalized failed", async () => {
		const { projectId, taskId } = await setupFixture();

		// paramsJson=null → parseExperimentConfig will fail with "params_json is required"
		const routineRes = await createRoutine(handle, log, {
			projectId,
			name: "InvalidExperiment",
			kind: "experiment",
			promptName: "default",
			paramsJson: null,
		});
		expect(routineRes.ok).toBe(true);
		if (!routineRes.ok) return;
		const routineId = routineRes.routine.id;

		const result = await dispatchExperiment(
			{ handle, log },
			{ routineId, taskId, maxIterations: 1 },
		);

		// Top-level dispatch succeeds (run was created).
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// But the loop returns a config error.
		expect(result.result.ok).toBe(false);
		if (result.result.ok) return;
		expect(result.result.reason).toMatch(/params_json is required/);

		// The run row should have state "failed" and kind "experiment".
		const runRow = handle.db
			.select()
			.from(runs)
			.where(eq(runs.id, result.runId))
			.get();
		expect(runRow).toBeDefined();
		expect(runRow?.state).toBe("failed");
		expect(runRow?.kind).toBe("experiment");
	});

	test("experiment routine with valid params + injected fake deps → run succeeds", async () => {
		const { projectId, taskId } = await setupFixture();

		const validParams = JSON.stringify({
			target_paths: ["src/app"],
			eval_command: "echo 1",
			metric: { name: "score", direction: "higher" },
			keep_rule: "improved",
		});

		const routineRes = await createRoutine(handle, log, {
			projectId,
			name: "ValidExperiment",
			kind: "experiment",
			promptName: "default",
			paramsJson: validParams,
		});
		expect(routineRes.ok).toBe(true);
		if (!routineRes.ok) return;
		const routineId = routineRes.routine.id;

		// Fake deps: produceEdit returns {ok:false} so loop does a bounded no-op.
		const fakeDeps: ExperimentRunDeps = {
			handle,
			log,
			now: () => 1,
			produceEdit: async () => ({ ok: false, reason: "noop" }),
			commit: async () => {
				throw new Error("should not be called");
			},
			evalRunner: async () => {
				throw new Error("should not be called");
			},
			parseMetric: (_stdout, _name) => {
				throw new Error("should not be called");
			},
			reset: async () => {
				throw new Error("should not be called");
			},
		};

		const result = await dispatchExperiment(
			{ handle, log, experimentDeps: fakeDeps },
			{ routineId, taskId, maxIterations: 1 },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.result.ok).toBe(true);
		if (!result.result.ok) return;

		// The run row should have state "succeeded".
		const runRow = handle.db
			.select()
			.from(runs)
			.where(eq(runs.id, result.runId))
			.get();
		expect(runRow).toBeDefined();
		expect(runRow?.state).toBe("succeeded");
		expect(runRow?.kind).toBe("experiment");
	});

	test("createRun spy is honored", async () => {
		const { projectId, taskId } = await setupFixture();

		const validParams = JSON.stringify({
			target_paths: ["src/app"],
			eval_command: "echo 1",
			metric: { name: "score", direction: "higher" },
			keep_rule: "improved",
		});

		const routineRes = await createRoutine(handle, log, {
			projectId,
			name: "SpyExperiment",
			kind: "experiment",
			promptName: "default",
			paramsJson: validParams,
		});
		expect(routineRes.ok).toBe(true);
		if (!routineRes.ok) return;
		const routineId = routineRes.routine.id;

		let createRunCalled = false;
		let createRunInput: Parameters<typeof realCreateRun>[1] | undefined;

		const spiedCreateRun = async (
			h: typeof handle,
			input: Parameters<typeof realCreateRun>[1],
		) => {
			createRunCalled = true;
			createRunInput = input;
			return realCreateRun(h, input);
		};

		const fakeDeps: ExperimentRunDeps = {
			handle,
			log,
			now: () => 1,
			produceEdit: async () => ({ ok: false, reason: "noop" }),
			commit: async () => {
				throw new Error("should not be called");
			},
			evalRunner: async () => {
				throw new Error("should not be called");
			},
			parseMetric: (_stdout, _name) => {
				throw new Error("should not be called");
			},
			reset: async () => {
				throw new Error("should not be called");
			},
		};

		const result = await dispatchExperiment(
			{ handle, log, experimentDeps: fakeDeps, createRun: spiedCreateRun },
			{ routineId, taskId, maxIterations: 1 },
		);

		expect(result.ok).toBe(true);
		expect(createRunCalled).toBe(true);
		expect(createRunInput).toBeDefined();
		expect(createRunInput?.kind).toBe("experiment");
	});
});
