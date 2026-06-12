/**
 * WHY: Hermetic tests for the planner (task 4.1). In-memory SQLite + real
 * migrations + a scripted PlannerLLM fake (returns canned stdout) so the whole
 * flow runs on macOS with no provider process.
 *
 * Critical invariants covered:
 *   - scripted plan → tasks created in BACKLOG with description + acceptance
 *     criteria, and dependency edges persisted.
 *   - a cyclic plan is rejected (PlannerError) and NOTHING is persisted.
 *   - malformed LLM output fails closed (PlannerError), no partial garbage.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects, tasks, taskDependencies } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { listTasks } from "../tasks/tasks.ts";
import { listDependencyIds } from "../tasks/dependencies.ts";
import { planToTasks, PlannerError, type PlannerLLM } from "./planner.ts";

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
		.values({ name: "p", repoUrl: "https://github.com/o/r.git", createdAt: now, updatedAt: now })
		.returning()
		.get().id;
});

/** A PlannerLLM that returns a fixed stdout string regardless of input. */
function scriptedLLM(stdout: string): PlannerLLM {
	return { plan: async () => stdout };
}

function planBlock(obj: unknown): string {
	return `noise before\n<plan>${JSON.stringify(obj)}</plan>\ntrailing prose`;
}

describe("planToTasks", () => {
	test("scripted plan → backlog tasks + deps created", async () => {
		const llm = scriptedLLM(
			planBlock({
				tasks: [
					{
						ref: "schema",
						title: "Add users table",
						description: "Create the users table migration.",
						acceptanceCriteria: ["migration applies clean", "users.email is unique"],
						dependsOn: [],
					},
					{
						ref: "api",
						title: "Add signup endpoint",
						description: "POST /signup writes a user.",
						acceptanceCriteria: ["returns 201 on valid input", "rejects duplicate email with 409"],
						dependsOn: ["schema"],
					},
				],
			}),
		);

		const result = await planToTasks({ handle, log, llm }, { projectId, planText: "build signup" });

		expect(result.tasks).toHaveLength(2);
		const backlog = listTasks(handle, { projectId, state: "backlog" });
		expect(backlog).toHaveLength(2);

		const api = result.tasks.find((t) => t.title === "Add signup endpoint")!;
		const schema = result.tasks.find((t) => t.title === "Add users table")!;
		expect(api.state).toBe("backlog");
		expect(api.description).toBe("POST /signup writes a user.");
		// Acceptance criteria persisted as a bullet list of testable assertions.
		expect(api.acceptanceCriteria).toContain("returns 201 on valid input");
		expect(api.acceptanceCriteria).toContain("\n- ");

		// Dependency edge persisted: api depends on schema.
		expect(listDependencyIds(handle, api.id)).toEqual([schema.id]);
		expect(result.dependencies).toContainEqual({ taskId: api.id, dependsOnTaskId: schema.id });
	});

	test("cyclic plan is rejected and nothing is persisted", async () => {
		const llm = scriptedLLM(
			planBlock({
				tasks: [
					{ ref: "a", title: "A", description: "a", acceptanceCriteria: ["x"], dependsOn: ["b"] },
					{ ref: "b", title: "B", description: "b", acceptanceCriteria: ["y"], dependsOn: ["a"] },
				],
			}),
		);

		await expect(
			planToTasks({ handle, log, llm }, { projectId, planText: "cyclic" }),
		).rejects.toThrow(PlannerError);

		// FAIL-CLOSED: no tasks and no dependency edges were written.
		expect(handle.db.select().from(tasks).all()).toHaveLength(0);
		expect(handle.db.select().from(taskDependencies).all()).toHaveLength(0);
	});

	test("malformed LLM output fails closed (no <plan> block)", async () => {
		const llm = scriptedLLM("I could not produce a plan, sorry.");

		await expect(
			planToTasks({ handle, log, llm }, { projectId, planText: "anything" }),
		).rejects.toThrow(PlannerError);

		expect(handle.db.select().from(tasks).all()).toHaveLength(0);
	});

	test("plan with a task missing acceptance criteria is rejected (§3.5), nothing persisted", async () => {
		const llm = scriptedLLM(
			planBlock({
				tasks: [
					{ ref: "ok", title: "OK", description: "ok", acceptanceCriteria: ["asserts"], dependsOn: [] },
					{ ref: "bad", title: "Bad", description: "missing criteria", acceptanceCriteria: [], dependsOn: [] },
				],
			}),
		);

		await expect(
			planToTasks({ handle, log, llm }, { projectId, planText: "x" }),
		).rejects.toThrow(/acceptance criterion/);

		// Validation happens before any insert — the first ("ok") task is NOT persisted.
		expect(handle.db.select().from(tasks).all()).toHaveLength(0);
	});

	test("dependency on an unknown ref is rejected, nothing persisted", async () => {
		const llm = scriptedLLM(
			planBlock({
				tasks: [
					{ ref: "a", title: "A", description: "a", acceptanceCriteria: ["x"], dependsOn: ["ghost"] },
				],
			}),
		);

		await expect(
			planToTasks({ handle, log, llm }, { projectId, planText: "x" }),
		).rejects.toThrow(/unknown ref/);

		expect(handle.db.select().from(tasks).all()).toHaveLength(0);
	});
});
