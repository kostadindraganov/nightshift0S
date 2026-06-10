/**
 * Schema invariant tests (task 1.2 verify criteria).
 *
 * Each test gets a fresh :memory: DB migrated via the committed SQL in
 * `drizzle/` — so these tests exercise the real migration, not a
 * drizzle-kit-pushed approximation. Invariants under test:
 *
 *   (a) one_active_run_per_task partial unique index
 *   (b) FK enforcement + cascade delete (tasks.project_id)
 *   (c) UNIQUE(task_id, seq) on thread_events
 *   (d) idempotency_key dedupe (and NULL-distinct non-dedupe)
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openDatabase, type DbHandle } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { projects, runs, tasks, threadEvents, type RunInsert } from "./schema.ts";

let handle: DbHandle;
const now = new Date().toISOString();

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
});

afterEach(() => {
	handle.sqlite.close();
});

function seedProject(): number {
	const row = handle.db
		.insert(projects)
		.values({ name: "p", repoUrl: "https://example.com/p.git", createdAt: now, updatedAt: now })
		.returning({ id: projects.id })
		.get();
	return row.id;
}

function seedTask(projectId: number): number {
	const row = handle.db
		.insert(tasks)
		.values({ projectId, title: "t", createdAt: now, updatedAt: now })
		.returning({ id: tasks.id })
		.get();
	return row.id;
}

function runValues(taskId: number, state: RunInsert["state"]): RunInsert {
	return { taskId, kind: "coder", provider: "claude", model: "opus", authLane: "subscription", state };
}

test("migration applies clean on a fresh DB (all 13 tables exist)", () => {
	const names = handle.sqlite
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name",
		)
		.all()
		.map((r) => r.name);
	expect(names).toEqual([
		"events",
		"experiment_ledger",
		"findings",
		"projects",
		"prompts",
		"providers",
		"routines",
		"runs",
		"settings",
		"task_dependencies",
		"tasks",
		"thread_events",
		"triggers",
	]);
});

test("one_active_run_per_task: two non-terminal runs for the same task throw", () => {
	const taskId = seedTask(seedProject());
	handle.db.insert(runs).values(runValues(taskId, "running")).run();
	expect(() => handle.db.insert(runs).values(runValues(taskId, "queued")).run()).toThrow(
		/UNIQUE constraint failed/,
	);
});

test("one_active_run_per_task: a terminal run and an active run coexist", () => {
	const taskId = seedTask(seedProject());
	const first = handle.db
		.insert(runs)
		.values(runValues(taskId, "running"))
		.returning({ id: runs.id })
		.get();
	// First run terminates → the partial index frees the slot.
	handle.db.update(runs).set({ state: "failed" }).where(eq(runs.id, first.id)).run();
	handle.db.insert(runs).values(runValues(taskId, "starting")).run();
	// Multiple terminal runs also coexist (the index only covers active states).
	handle.db.insert(runs).values(runValues(taskId, "killed")).run();
	expect(handle.db.select().from(runs).all()).toHaveLength(3);
});

test("FK enforcement: tasks.project_id must reference an existing project", () => {
	expect(() =>
		handle.db
			.insert(tasks)
			.values({ projectId: 9999, title: "orphan", createdAt: now, updatedAt: now })
			.run(),
	).toThrow(/FOREIGN KEY constraint failed/);
});

test("cascade delete: deleting a project deletes its tasks and thread_events", () => {
	const projectId = seedProject();
	const taskId = seedTask(projectId);
	handle.db
		.insert(threadEvents)
		.values({ taskId, seq: 1, kind: "message", actor: "system", payloadJson: "{}", createdAt: now })
		.run();
	handle.db.delete(projects).where(eq(projects.id, projectId)).run();
	expect(handle.db.select().from(tasks).all()).toHaveLength(0);
	expect(handle.db.select().from(threadEvents).all()).toHaveLength(0);
});

test("thread_events UNIQUE(task_id, seq): duplicate seq for a task throws", () => {
	const taskId = seedTask(seedProject());
	const values = { taskId, seq: 1, kind: "message", actor: "system", payloadJson: "{}", createdAt: now } as const;
	handle.db.insert(threadEvents).values(values).run();
	expect(() => handle.db.insert(threadEvents).values(values).run()).toThrow(
		/UNIQUE constraint failed/,
	);
	// Same seq on a DIFFERENT task is fine — seq is per-task.
	const otherTask = seedTask(seedProject());
	handle.db.insert(threadEvents).values({ ...values, taskId: otherTask }).run();
});

test("idempotency_key: duplicate key throws, NULL keys never collide", () => {
	const taskId = seedTask(seedProject());
	const base = { taskId, kind: "message", actor: "system", payloadJson: "{}", createdAt: now } as const;
	handle.db.insert(threadEvents).values({ ...base, seq: 1, idempotencyKey: "hook-abc" }).run();
	expect(() =>
		handle.db.insert(threadEvents).values({ ...base, seq: 2, idempotencyKey: "hook-abc" }).run(),
	).toThrow(/UNIQUE constraint failed/);
	// SQLite treats NULLs as distinct: rows without a key never dedupe.
	handle.db.insert(threadEvents).values({ ...base, seq: 3 }).run();
	handle.db.insert(threadEvents).values({ ...base, seq: 4 }).run();
	expect(handle.db.select().from(threadEvents).all()).toHaveLength(3);
});
