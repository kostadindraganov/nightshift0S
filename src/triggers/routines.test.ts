/**
 * Routines CRUD tests (UNIT 5.8d).
 *
 * Coverage matrix:
 *   1. createRoutine: valid input succeeds, invalid input fails.
 *   2. updateRoutine: patches work, not_found error, validation on each field.
 *   3. deleteRoutine: succeeds, not_found error.
 *   4. listRoutines: filters by projectId / kind / enabled; returns sorted by id.
 *   5. Events: created / updated / deleted all emit, never carry secrets.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { events, projects, routines } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import {
	createRoutine,
	deleteRoutine,
	getRoutine,
	listRoutines,
	updateRoutine,
	type UpdateRoutinePatch,
} from "./routines.ts";

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

// ---------------------------------------------------------------------------
// 1. createRoutine: happy path + validation
// ---------------------------------------------------------------------------

test("createRoutine: valid routine succeeds and emits event", async () => {
	const result = await createRoutine(handle, log, {
		name: "code-review",
		kind: "task",
		promptName: "review-pr",
		reviewPolicy: "full",
		enabled: true,
	});

	expect(result.ok).toBe(true);
	if (!result.ok) return;

	expect(result.routine.name).toBe("code-review");
	expect(result.routine.kind).toBe("task");
	expect(result.routine.promptName).toBe("review-pr");
	expect(result.routine.reviewPolicy).toBe("full");
	expect(result.routine.enabled).toBe(true);
	expect(result.routine.id).toBeGreaterThan(0);

	// Check event was emitted.
	const evs = handle.db.select().from(events).all();
	const created = evs.find((e) => e.kind === "routine.created");
	expect(created).toBeDefined();
	if (created) {
		const payload = JSON.parse(created.payloadJson) as Record<string, unknown>;
		expect(payload.routineId).toBe(result.routine.id);
		expect(payload.name).toBe("code-review");
		expect(payload.kind).toBe("task");
		// Ensure no secrets leak into payload.
		expect(Object.keys(payload)).not.toContain("paramsJson");
	}
});

test("createRoutine: optional fields default correctly", async () => {
	const result = await createRoutine(handle, log, {
		name: "experiment",
		kind: "experiment",
		promptName: "optimize",
	});

	expect(result.ok).toBe(true);
	if (!result.ok) return;

	expect(result.routine.reviewPolicy).toBe("full");
	expect(result.routine.enabled).toBe(true);
	expect(result.routine.projectId).toBeNull();
	expect(result.routine.paramsJson).toBeNull();
	expect(result.routine.budgetJson).toBeNull();
});

test("createRoutine: with projectId", async () => {
	const proj = handle.db
		.insert(projects)
		.values({
			name: "test",
			repoUrl: "https://example.com/repo",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.returning()
		.get();

	const result = await createRoutine(handle, log, {
		projectId: proj.id,
		name: "project-routine",
		kind: "task",
		promptName: "test",
	});

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.routine.projectId).toBe(proj.id);
});

test("createRoutine: rejects missing name", async () => {
	const result = await createRoutine(handle, log, {
		name: "",
		kind: "task",
		promptName: "test",
	});
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toContain("name is required");
});

test("createRoutine: rejects missing promptName", async () => {
	const result = await createRoutine(handle, log, {
		name: "test",
		kind: "task",
		promptName: "   ",
	});
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toContain("promptName is required");
});

test("createRoutine: rejects invalid kind", async () => {
	const result = await createRoutine(handle, log, {
		name: "test",
		kind: "invalid" as any,
		promptName: "test",
	});
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toContain("invalid kind");
});

test("createRoutine: rejects invalid reviewPolicy", async () => {
	const result = await createRoutine(handle, log, {
		name: "test",
		kind: "task",
		promptName: "test",
		reviewPolicy: "bad-policy" as any,
	});
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toContain("invalid reviewPolicy");
});

test("createRoutine: rejects unparseable paramsJson", async () => {
	const result = await createRoutine(handle, log, {
		name: "test",
		kind: "task",
		promptName: "test",
		paramsJson: "not valid json",
	});
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toContain("params_json must be valid JSON");
});

test("createRoutine: accepts valid JSON in paramsJson and budgetJson", async () => {
	const result = await createRoutine(handle, log, {
		name: "test",
		kind: "task",
		promptName: "test",
		paramsJson: '{"key":"value"}',
		budgetJson: '{"maxTokens":1000}',
	});
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.routine.paramsJson).toBe('{"key":"value"}');
	expect(result.routine.budgetJson).toBe('{"maxTokens":1000}');
});

test("createRoutine: rejects unparseable budgetJson (fail-closed, no row persisted)", async () => {
	const result = await createRoutine(handle, log, {
		name: "test",
		kind: "task",
		promptName: "test",
		budgetJson: "{not-json",
	});
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toContain("budget_json must be valid JSON");
	// No half-valid row may have been written.
	expect(listRoutines(handle).length).toBe(0);
});

test("createRoutine: never leaks paramsJson/budgetJson content into the created event", async () => {
	// The audit event must carry ids/names/policy only — never the raw config
	// blobs (which may hold provider hints / budget secrets, §3.12.7).
	const result = await createRoutine(handle, log, {
		name: "leaky",
		kind: "task",
		promptName: "test",
		paramsJson: '{"apiBase":"https://secret.internal/x"}',
		budgetJson: '{"hardCapUsd":4242}',
	});
	expect(result.ok).toBe(true);
	if (!result.ok) return;

	const created = handle.db.select().from(events).all().find((e) => e.kind === "routine.created");
	expect(created).toBeDefined();
	if (created) {
		expect(created.payloadJson).not.toContain("secret.internal");
		expect(created.payloadJson).not.toContain("hardCapUsd");
		expect(created.payloadJson).not.toContain("4242");
	}
});

// ---------------------------------------------------------------------------
// 2. getRoutine + listRoutines
// ---------------------------------------------------------------------------

test("getRoutine: returns routine by id or null", async () => {
	const result = await createRoutine(handle, log, {
		name: "test",
		kind: "task",
		promptName: "test",
	});
	expect(result.ok).toBe(true);
	if (!result.ok) return;

	const fetched = getRoutine(handle, result.routine.id);
	expect(fetched).toBeDefined();
	expect(fetched?.name).toBe("test");

	const missing = getRoutine(handle, 999);
	expect(missing).toBeNull();
});

test("listRoutines: no filter returns all, sorted by id", async () => {
	await createRoutine(handle, log, {
		name: "first",
		kind: "task",
		promptName: "test",
	});
	await createRoutine(handle, log, {
		name: "second",
		kind: "experiment",
		promptName: "test",
	});

	const all = listRoutines(handle);
	expect(all.length).toBe(2);
	expect(all[0]!.name).toBe("first");
	expect(all[1]!.name).toBe("second");
});

test("listRoutines: filter by kind", async () => {
	await createRoutine(handle, log, {
		name: "task-routine",
		kind: "task",
		promptName: "test",
	});
	await createRoutine(handle, log, {
		name: "exp-routine",
		kind: "experiment",
		promptName: "test",
	});

	const tasks = listRoutines(handle, { kind: "task" });
	expect(tasks.length).toBe(1);
	expect(tasks[0]!.name).toBe("task-routine");

	const exps = listRoutines(handle, { kind: "experiment" });
	expect(exps.length).toBe(1);
	expect(exps[0]!.name).toBe("exp-routine");
});

test("listRoutines: filter by enabled", async () => {
	await createRoutine(handle, log, {
		name: "enabled",
		kind: "task",
		promptName: "test",
		enabled: true,
	});
	await createRoutine(handle, log, {
		name: "disabled",
		kind: "task",
		promptName: "test",
		enabled: false,
	});

	const enabled = listRoutines(handle, { enabled: true });
	expect(enabled.length).toBe(1);
	expect(enabled[0]!.name).toBe("enabled");

	const disabled = listRoutines(handle, { enabled: false });
	expect(disabled.length).toBe(1);
	expect(disabled[0]!.name).toBe("disabled");
});

test("listRoutines: filter by projectId", async () => {
	const proj = handle.db
		.insert(projects)
		.values({
			name: "test",
			repoUrl: "https://example.com/repo",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.returning()
		.get();

	await createRoutine(handle, log, {
		projectId: proj.id,
		name: "project-routine",
		kind: "task",
		promptName: "test",
	});
	await createRoutine(handle, log, {
		projectId: null,
		name: "global-routine",
		kind: "task",
		promptName: "test",
	});

	const byProject = listRoutines(handle, { projectId: proj.id });
	expect(byProject.length).toBe(1);
	expect(byProject[0]!.name).toBe("project-routine");

	// No filter returns all including the global routine.
	const all = listRoutines(handle);
	expect(all.length).toBe(2);
	const global = all.find((r) => r.projectId === null);
	expect(global?.name).toBe("global-routine");
});

// ---------------------------------------------------------------------------
// 3. updateRoutine: patches and validation
// ---------------------------------------------------------------------------

test("updateRoutine: patches name and kind", async () => {
	const created = await createRoutine(handle, log, {
		name: "original",
		kind: "task",
		promptName: "test",
	});
	expect(created.ok).toBe(true);
	if (!created.ok) return;

	const patched = await updateRoutine(handle, log, created.routine.id, {
		name: "updated",
		kind: "experiment",
	});
	expect(patched.ok).toBe(true);
	if (!patched.ok) return;
	expect(patched.routine.name).toBe("updated");
	expect(patched.routine.kind).toBe("experiment");

	// Verify in DB.
	const fetched = getRoutine(handle, created.routine.id);
	expect(fetched?.name).toBe("updated");
	expect(fetched?.kind).toBe("experiment");
});

test("updateRoutine: patches reviewPolicy and enabled", async () => {
	const created = await createRoutine(handle, log, {
		name: "test",
		kind: "task",
		promptName: "test",
		reviewPolicy: "full",
		enabled: true,
	});
	expect(created.ok).toBe(true);
	if (!created.ok) return;

	const patched = await updateRoutine(handle, log, created.routine.id, {
		reviewPolicy: "light",
		enabled: false,
	});
	expect(patched.ok).toBe(true);
	if (!patched.ok) return;
	expect(patched.routine.reviewPolicy).toBe("light");
	expect(patched.routine.enabled).toBe(false);
});

test("updateRoutine: patches JSON fields", async () => {
	const created = await createRoutine(handle, log, {
		name: "test",
		kind: "task",
		promptName: "test",
	});
	expect(created.ok).toBe(true);
	if (!created.ok) return;

	const patched = await updateRoutine(handle, log, created.routine.id, {
		paramsJson: '{"newKey":"newValue"}',
		budgetJson: '{"tokenLimit":5000}',
	});
	expect(patched.ok).toBe(true);
	if (!patched.ok) return;
	expect(patched.routine.paramsJson).toBe('{"newKey":"newValue"}');
	expect(patched.routine.budgetJson).toBe('{"tokenLimit":5000}');
});

test("updateRoutine: rejects invalid patch values", async () => {
	const created = await createRoutine(handle, log, {
		name: "test",
		kind: "task",
		promptName: "test",
	});
	expect(created.ok).toBe(true);
	if (!created.ok) return;

	const badKind = await updateRoutine(handle, log, created.routine.id, {
		kind: "invalid" as any,
	});
	expect(badKind.ok).toBe(false);
	if (badKind.ok) return;
	expect(badKind.reason).toContain("invalid kind");

	const badPolicy = await updateRoutine(handle, log, created.routine.id, {
		reviewPolicy: "bad" as any,
	});
	expect(badPolicy.ok).toBe(false);
	if (badPolicy.ok) return;
	expect(badPolicy.reason).toContain("invalid reviewPolicy");

	const badJson = await updateRoutine(handle, log, created.routine.id, {
		paramsJson: "not json",
	});
	expect(badJson.ok).toBe(false);
	if (badJson.ok) return;
	expect(badJson.reason).toContain("params_json must be valid JSON");
});

test("updateRoutine: not_found on missing routine", async () => {
	const result = await updateRoutine(handle, log, 999, { name: "new" });
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("not_found");
});

test("updateRoutine: empty patch returns existing routine unchanged", async () => {
	const created = await createRoutine(handle, log, {
		name: "test",
		kind: "task",
		promptName: "test",
	});
	expect(created.ok).toBe(true);
	if (!created.ok) return;

	const result = await updateRoutine(handle, log, created.routine.id, {});
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.routine.name).toBe("test");
	expect(result.routine.id).toBe(created.routine.id);
});

test("updateRoutine: emits updated event without secrets", async () => {
	const created = await createRoutine(handle, log, {
		name: "test",
		kind: "task",
		promptName: "test",
		paramsJson: '{"secret":"value"}',
	});
	expect(created.ok).toBe(true);
	if (!created.ok) return;

	// Clear events.
	handle.db.delete(events).run();

	const patched = await updateRoutine(handle, log, created.routine.id, {
		name: "updated",
	});
	expect(patched.ok).toBe(true);

	const evs = handle.db.select().from(events).all();
	const updated = evs.find((e) => e.kind === "routine.updated");
	expect(updated).toBeDefined();
	if (updated) {
		const payload = JSON.parse(updated.payloadJson) as Record<string, unknown>;
		expect(payload.name).toBe("updated");
		// Ensure no secrets leak.
		expect(Object.keys(payload)).not.toContain("paramsJson");
	}
});

// ---------------------------------------------------------------------------
// 4. deleteRoutine
// ---------------------------------------------------------------------------

test("deleteRoutine: succeeds and emits event", async () => {
	const created = await createRoutine(handle, log, {
		name: "to-delete",
		kind: "task",
		promptName: "test",
	});
	expect(created.ok).toBe(true);
	if (!created.ok) return;

	const result = await deleteRoutine(handle, log, created.routine.id);
	expect(result.ok).toBe(true);

	// Verify it's gone.
	const fetched = getRoutine(handle, created.routine.id);
	expect(fetched).toBeNull();

	// Check event.
	const evs = handle.db.select().from(events).all();
	const deleted = evs.find((e) => e.kind === "routine.deleted");
	expect(deleted).toBeDefined();
	if (deleted) {
		const payload = JSON.parse(deleted.payloadJson) as Record<string, unknown>;
		expect(payload.routineId).toBe(created.routine.id);
		expect(payload.name).toBe("to-delete");
	}
});

test("deleteRoutine: not_found on missing routine", async () => {
	const result = await deleteRoutine(handle, log, 999);
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("not_found");
});
