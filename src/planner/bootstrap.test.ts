/**
 * WHY: Focused tests for bootstrapProject — the critical invariants are:
 *   1. Valid planner output → tasks inserted with correct titles, ok:true.
 *   2. Unparseable planner output → ok:false, DB untouched (fail-closed).
 *   3. Empty description → ok:false without calling planner.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects } from "../db/schema.ts";
import { listTasks } from "../tasks/tasks.ts";
import { bootstrapProject, type Planner } from "./bootstrap.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let handle: DbHandle;
let projectId: number;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	const now = new Date().toISOString();
	projectId = handle.db
		.insert(projects)
		.values({ name: "test", repoUrl: "https://github.com/o/r.git", createdAt: now, updatedAt: now })
		.returning()
		.get().id;
});

// ---------------------------------------------------------------------------
// Fake planner builder
// ---------------------------------------------------------------------------

function makePlanner(stdout: string): Planner {
	return { runOnce: async (_input) => ({ stdout }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bootstrapProject", () => {
	test("valid planner output → ok:true, tasks created in DB", async () => {
		const output = `<output>[{"title":"Task A","description":"desc A"},{"title":"Task B"}]</output>`;
		const result = await bootstrapProject(
			{ handle, planner: makePlanner(output) },
			{ projectId, description: "Build a todo app" },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.tasks).toHaveLength(2);
		expect(result.tasks[0]!.title).toBe("Task A");
		expect(result.tasks[1]!.title).toBe("Task B");

		// Tasks must actually be in the DB.
		const rows = listTasks(handle, { projectId });
		expect(rows).toHaveLength(2);
		expect(rows[0]!.state).toBe("backlog");
	});

	test("planner returns garbage → ok:false, no tasks created (fail-closed)", async () => {
		const result = await bootstrapProject(
			{ handle, planner: makePlanner("I don't know what to do") },
			{ projectId, description: "Some project" },
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toMatch(/could not be parsed/);

		// DB must be untouched.
		const rows = listTasks(handle, { projectId });
		expect(rows).toHaveLength(0);
	});

	test("empty description → ok:false, planner never called", async () => {
		let called = false;
		const planner: Planner = {
			runOnce: async (_input) => {
				called = true;
				return { stdout: "" };
			},
		};

		const result = await bootstrapProject(
			{ handle, planner },
			{ projectId, description: "   " },
		);

		expect(result.ok).toBe(false);
		expect(called).toBe(false);
	});
});
