/**
 * WHY: Hermetic unit tests for tryAutoMerge. Uses in-memory SQLite + fake
 * preflight/merge/confirmMergeAndUnblock so no network, no real git, no
 * GitHub token is needed. Five focused cases cover the full decision tree.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects, tasks } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { getTask } from "../tasks/tasks.ts";
import { addDependency } from "../tasks/dependencies.ts";
import { tryAutoMerge, type AutoMergeDeps, type AutoMergeConfig } from "./autoMerge.ts";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

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
		.values({
			name: "auto-merge-test",
			repoUrl: "https://github.com/o/r.git",
			createdAt: now,
			updatedAt: now,
		})
		.returning()
		.get().id;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedTask(state: "approved" | "merging" | "review"): number {
	const now = new Date().toISOString();
	return handle.db
		.insert(tasks)
		.values({ projectId, title: "t", state, priority: 0, createdAt: now, updatedAt: now })
		.returning()
		.get().id;
}

function enabledConfig(): AutoMergeConfig {
	return { review: { autoMergeEnabled: true } };
}

function disabledConfig(): AutoMergeConfig {
	return { review: { autoMergeEnabled: false } };
}

function makeDeps(
	overrides: Partial<Pick<AutoMergeDeps, "preflight" | "mergePullRequest" | "config">>,
): AutoMergeDeps {
	return {
		handle,
		log,
		config: overrides.config ?? enabledConfig(),
		preflight: overrides.preflight ?? (async () => ({ pass: true, blocked: [] })),
		mergePullRequest: overrides.mergePullRequest ?? (async () => "sha-default"),
	};
}

// ---------------------------------------------------------------------------
// Case 1: disabled gate — no-op, no mutations
// ---------------------------------------------------------------------------

describe("tryAutoMerge", () => {
	test("disabled gate → outcome disabled, no state mutations", async () => {
		const taskId = seedTask("approved");

		const deps = makeDeps({ config: disabledConfig() });
		const result = await tryAutoMerge(deps, taskId);

		expect(result.outcome).toBe("disabled");

		// Task stays in approved — nothing was touched.
		expect(getTask(handle, taskId)?.state).toBe("approved");
	});

	// -------------------------------------------------------------------------
	// Case 2: preflight blocked → needs_human with reasons, no merge call
	// -------------------------------------------------------------------------

	test("preflight block → needs_human carrying blocked reasons, merge never called", async () => {
		const taskId = seedTask("approved");

		let mergeCalled = false;

		const deps = makeDeps({
			preflight: async () => ({ pass: false, blocked: ["checks red", "stale head"] }),
			mergePullRequest: async () => {
				mergeCalled = true;
				return "irrelevant";
			},
		});

		const result = await tryAutoMerge(deps, taskId);

		expect(result.outcome).toBe("needs_human");
		if (result.outcome === "needs_human") {
			expect(result.blocked).toContain("checks red");
			expect(result.blocked).toContain("stale head");
		}

		// Merge must NOT have been called.
		expect(mergeCalled).toBe(false);

		// Task must land in needs_human (never silently left in approved or merging).
		expect(getTask(handle, taskId)?.state).toBe("needs_human");
	});

	// -------------------------------------------------------------------------
	// Case 3: preflight pass → approved→merging→done + dependents unblocked
	// -------------------------------------------------------------------------

	test("preflight pass → approved→merging→done, dependents unblocked", async () => {
		const taskId = seedTask("approved");

		// Task B in backlog depends on taskId.
		const now = new Date().toISOString();
		const depTaskId = handle.db
			.insert(tasks)
			.values({ projectId, title: "dep", state: "backlog", priority: 1, createdAt: now, updatedAt: now })
			.returning()
			.get().id;
		await addDependency(handle, depTaskId, taskId);

		const sha = "cafebabe00000000000000000000000000000000";

		const deps = makeDeps({
			preflight: async () => ({ pass: true, blocked: [] }),
			mergePullRequest: async () => sha,
		});

		const result = await tryAutoMerge(deps, taskId);

		expect(result.outcome).toBe("merged");
		if (result.outcome === "merged") {
			expect(result.mergeSha).toBe(sha);
			expect(result.unblocked).toContain(depTaskId);
		}

		// Task is done with the merge SHA recorded.
		const task = getTask(handle, taskId);
		expect(task?.state).toBe("done");
		expect(task?.mergeSha).toBe(sha);

		// Dependent was promoted to ready.
		expect(getTask(handle, depTaskId)?.state).toBe("ready");
	});

	// -------------------------------------------------------------------------
	// Case 4: task not in approved → skipped
	// -------------------------------------------------------------------------

	test("task in wrong state (merging) → skipped, no transitions fired", async () => {
		const taskId = seedTask("merging");

		const deps = makeDeps({});
		const result = await tryAutoMerge(deps, taskId);

		expect(result.outcome).toBe("skipped");
		if (result.outcome === "skipped") {
			expect(result.reason).toMatch(/not in approved/);
		}

		// Task stays in merging — no mutation.
		expect(getTask(handle, taskId)?.state).toBe("merging");
	});

	// -------------------------------------------------------------------------
	// Case 5: merge call throws → needs_human (merge_blocked), task not stuck
	// -------------------------------------------------------------------------

	test("merge call throws → needs_human, task not left in merging", async () => {
		const taskId = seedTask("approved");

		const deps = makeDeps({
			preflight: async () => ({ pass: true, blocked: [] }),
			mergePullRequest: async () => {
				throw new Error("GitHub 409 merge conflict");
			},
		});

		const result = await tryAutoMerge(deps, taskId);

		expect(result.outcome).toBe("needs_human");
		if (result.outcome === "needs_human") {
			expect(result.blocked.some((b) => b.includes("GitHub 409"))).toBe(true);
		}

		// Must NOT be stuck in merging — parked in needs_human.
		expect(getTask(handle, taskId)?.state).toBe("needs_human");
	});
});
