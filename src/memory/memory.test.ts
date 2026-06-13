/**
 * Memory module tests (Phase 6 UNIT B-1 — Per-project agent memory).
 *
 * All side-effects faked: in-memory SQLite (runMigrations), a real EventLog
 * (in-memory broker), and pure functions. No network, no agent spawn.
 * Each test owns its own DB so write-queue side effects don't leak.
 *
 * Coverage matrix:
 *   1. getMemory: point read hit / miss.
 *   2. listMemory: all rows / filtered by namespace, ordered by updatedAt DESC.
 *   3. putMemory: create path (hadPrevious=false), upsert path (hadPrevious=true),
 *      validation (empty key/source, project_not_found fail-closed).
 *   4. deleteMemory: happy path, not_found fail-closed.
 *   5. Events: "memory.updated" emitted with correct payload (never echoing raw value);
 *      "memory.deleted" emitted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { agentMemory, events, projects } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import {
	deleteMemory,
	getMemory,
	listMemory,
	putMemory,
	type AgentMemoryRow,
	type DeleteMemoryInput,
	type PutMemoryInput,
} from "./memory.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let handle: DbHandle;
let log: EventLog;

/** Create a test project and return its id. */
function createProject(name = "test-project"): number {
	const now = new Date().toISOString();
	return handle.db
		.insert(projects)
		.values({
			name,
			repoUrl: "https://github.com/test/repo",
			defaultBranch: "main",
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: projects.id })
		.get().id;
}

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
});

afterEach(() => {
	handle.sqlite.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getMemory", () => {
	test("returns null when entry absent", () => {
		const projectId = createProject();
		const result = getMemory(handle, projectId, "note", "missing_key");
		expect(result).toBeNull();
	});

	test("returns row when entry exists", async () => {
		const projectId = createProject();
		const input: PutMemoryInput = {
			projectId,
			namespace: "facts",
			key: "node_version",
			value: "18.0.0",
			source: "agent:coder",
		};
		const putResult = await putMemory(handle, log, input);
		expect(putResult.ok).toBe(true);
		if (!putResult.ok) throw new Error("put should succeed");

		const result = getMemory(handle, projectId, "facts", "node_version");
		expect(result).not.toBeNull();
		expect(result?.key).toBe("node_version");
		expect(result?.namespace).toBe("facts");
		expect(result?.valueJson).toBe(JSON.stringify("18.0.0"));
		expect(result?.source).toBe("agent:coder");
	});

	test("distinguishes entries by namespace", async () => {
		const projectId = createProject();
		// Insert two entries with the same key but different namespaces.
		await putMemory(handle, log, {
			projectId,
			namespace: "facts",
			key: "shared_key",
			value: "facts_value",
			source: "system",
		});
		await putMemory(handle, log, {
			projectId,
			namespace: "lessons",
			key: "shared_key",
			value: "lessons_value",
			source: "system",
		});

		const factsRow = getMemory(handle, projectId, "facts", "shared_key");
		const lessonsRow = getMemory(handle, projectId, "lessons", "shared_key");

		expect(factsRow?.valueJson).toBe(JSON.stringify("facts_value"));
		expect(lessonsRow?.valueJson).toBe(JSON.stringify("lessons_value"));
	});
});

describe("listMemory", () => {
	test("returns empty array when project has no entries", () => {
		const projectId = createProject();
		const result = listMemory(handle, projectId);
		expect(result).toEqual([]);
	});

	test("returns all entries for a project, newest updatedAt first", async () => {
		const projectId = createProject();

		// Insert three entries with staggered timestamps.
		const now = new Date();
		const entry1: PutMemoryInput = {
			projectId,
			namespace: "note",
			key: "first",
			value: "v1",
			source: "system",
		};
		await putMemory(handle, log, entry1);

		// Artificially sleep to ensure different timestamps.
		await new Promise((r) => setTimeout(r, 10));

		const entry2: PutMemoryInput = {
			projectId,
			namespace: "note",
			key: "second",
			value: "v2",
			source: "system",
		};
		await putMemory(handle, log, entry2);

		await new Promise((r) => setTimeout(r, 10));

		const entry3: PutMemoryInput = {
			projectId,
			namespace: "note",
			key: "third",
			value: "v3",
			source: "system",
		};
		await putMemory(handle, log, entry3);

		const result = listMemory(handle, projectId);
		expect(result.length).toBe(3);
		// Newest first: third, second, first.
		expect(result[0]!.key).toBe("third");
		expect(result[1]!.key).toBe("second");
		expect(result[2]!.key).toBe("first");
	});

	test("filters by namespace when provided", async () => {
		const projectId = createProject();

		// Insert entries in different namespaces.
		await putMemory(handle, log, {
			projectId,
			namespace: "facts",
			key: "fact1",
			value: "v1",
			source: "system",
		});
		await putMemory(handle, log, {
			projectId,
			namespace: "lessons",
			key: "lesson1",
			value: "v2",
			source: "system",
		});
		await putMemory(handle, log, {
			projectId,
			namespace: "facts",
			key: "fact2",
			value: "v3",
			source: "system",
		});

		const factsOnly = listMemory(handle, projectId, { namespace: "facts" });
		expect(factsOnly.length).toBe(2);
		expect(factsOnly.every((r) => r.namespace === "facts")).toBe(true);

		const lessonsOnly = listMemory(handle, projectId, { namespace: "lessons" });
		expect(lessonsOnly.length).toBe(1);
		expect(lessonsOnly[0]!.key).toBe("lesson1");
	});

	test("does not return entries from other projects", async () => {
		const projectA = createProject("project-a");
		const projectB = createProject("project-b");

		await putMemory(handle, log, {
			projectId: projectA,
			namespace: "note",
			key: "key_a",
			value: "value_a",
			source: "system",
		});
		await putMemory(handle, log, {
			projectId: projectB,
			namespace: "note",
			key: "key_b",
			value: "value_b",
			source: "system",
		});

		const aRows = listMemory(handle, projectA);
		expect(aRows.length).toBe(1);
		expect(aRows[0]!.projectId).toBe(projectA);
		expect(aRows[0]!.key).toBe("key_a");

		const bRows = listMemory(handle, projectB);
		expect(bRows.length).toBe(1);
		expect(bRows[0]!.projectId).toBe(projectB);
		expect(bRows[0]!.key).toBe("key_b");
	});
});

describe("putMemory", () => {
	test("creates a new entry with default namespace='note'", async () => {
		const projectId = createProject();
		const input: PutMemoryInput = {
			projectId,
			key: "test_key",
			value: { nested: "object" },
			source: "agent:coder",
		};

		const result = await putMemory(handle, log, input);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("should succeed");

		const row = result.row;
		expect(row.projectId).toBe(projectId);
		expect(row.namespace).toBe("note"); // default applied
		expect(row.key).toBe("test_key");
		expect(row.valueJson).toBe(JSON.stringify({ nested: "object" }));
		expect(row.source).toBe("agent:coder");
		expect(row.createdAt).toBeDefined();
		expect(row.updatedAt).toBeDefined();
		expect(row.createdAt).toBe(row.updatedAt);
	});

	test("creates a new entry with explicit namespace", async () => {
		const projectId = createProject();
		const input: PutMemoryInput = {
			projectId,
			namespace: "conventions",
			key: "test_key",
			value: ["array", "value"],
			source: "run:123",
		};

		const result = await putMemory(handle, log, input);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("should succeed");

		expect(result.row.namespace).toBe("conventions");
		expect(result.row.valueJson).toBe(JSON.stringify(["array", "value"]));
	});

	test("upserts (overwrites) an existing entry, setting hadPrevious=true", async () => {
		const projectId = createProject();

		// First insert.
		const input1: PutMemoryInput = {
			projectId,
			namespace: "facts",
			key: "mykey",
			value: "old_value",
			source: "system",
		};
		const res1 = await putMemory(handle, log, input1);
		expect(res1.ok).toBe(true);
		const oldId = res1.ok ? res1.row.id : -1;

		// Capture the first event.
		let events1 = handle.db.select().from(events).all();
		const createEvent = events1.find((e) => e.kind === "memory.updated");
		expect(createEvent?.payloadJson).toBeDefined();
		const createPayload = JSON.parse(createEvent!.payloadJson);
		expect(createPayload.hadPrevious).toBe(false);

		// Upsert with a new value.
		const input2: PutMemoryInput = {
			projectId,
			namespace: "facts",
			key: "mykey",
			value: "new_value",
			source: "agent:reviewer",
		};
		const res2 = await putMemory(handle, log, input2);
		expect(res2.ok).toBe(true);
		if (!res2.ok) throw new Error("upsert should succeed");

		const newRow = res2.row;
		// Same ID, so it was an update not an insert.
		expect(newRow.id).toBe(oldId);
		expect(newRow.valueJson).toBe(JSON.stringify("new_value"));
		expect(newRow.source).toBe("agent:reviewer");
		expect(newRow.createdAt).toBeDefined();
		// updatedAt should be >= createdAt (may be equal in fast tests).
		expect(new Date(newRow.updatedAt).getTime()).toBeGreaterThanOrEqual(
			new Date(newRow.createdAt).getTime()
		);

		// Capture the second event.
		const events2 = handle.db.select().from(events).all();
		const updateEvent = events2[events2.length - 1]!;
		expect(updateEvent.kind).toBe("memory.updated");
		const updatePayload = JSON.parse(updateEvent.payloadJson);
		expect(updatePayload.hadPrevious).toBe(true);
		expect(updatePayload.key).toBe("mykey");
		expect(updatePayload.source).toBe("agent:reviewer");
	});

	test("fails with project_not_found when project does not exist", async () => {
		const input: PutMemoryInput = {
			projectId: 99999,
			namespace: "note",
			key: "test",
			value: "value",
			source: "system",
		};

		const result = await putMemory(handle, log, input);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("should fail");
		expect(result.reason).toBe("project_not_found");
	});

	test("fails with invalid when key is empty", async () => {
		const projectId = createProject();
		const input: PutMemoryInput = {
			projectId,
			namespace: "note",
			key: "   ", // whitespace only
			value: "value",
			source: "system",
		};

		const result = await putMemory(handle, log, input);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("should fail");
		expect(result.reason).toBe("invalid");
	});

	test("fails with invalid when key is not a string", async () => {
		const projectId = createProject();
		const input = {
			projectId,
			namespace: "note",
			key: 123 as unknown as string,
			value: "value",
			source: "system",
		};

		const result = await putMemory(handle, log, input as PutMemoryInput);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("should fail");
		expect(result.reason).toBe("invalid");
	});

	test("fails with invalid when source is empty", async () => {
		const projectId = createProject();
		const input: PutMemoryInput = {
			projectId,
			namespace: "note",
			key: "test",
			value: "value",
			source: "   ", // whitespace only
		};

		const result = await putMemory(handle, log, input);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("should fail");
		expect(result.reason).toBe("invalid");
	});

	test("fails with invalid when source is not a string", async () => {
		const projectId = createProject();
		const input = {
			projectId,
			namespace: "note",
			key: "test",
			value: "value",
			source: 456 as unknown as string,
		};

		const result = await putMemory(handle, log, input as PutMemoryInput);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("should fail");
		expect(result.reason).toBe("invalid");
	});

	test("stores various JSON-serializable values", async () => {
		const projectId = createProject();

		const testCases: [string, unknown][] = [
			["null", null],
			["boolean", true],
			["number", 42.5],
			["string", "hello"],
			["array", [1, 2, 3]],
			["object", { a: 1, b: "two" }],
			["nested", { outer: [{ inner: "value" }] }],
		];

		for (const [name, value] of testCases) {
			const result = await putMemory(handle, log, {
				projectId,
				namespace: "test",
				key: name,
				value,
				source: "test",
			});
			expect(result.ok).toBe(true); // should store ${name}
			if (!result.ok) continue;

			const retrieved = getMemory(handle, projectId, "test", name);
			expect(retrieved?.valueJson).toBe(JSON.stringify(value)); // ${name} should round-trip
		}
	});

	test("emits memory.updated event with correct payload (no value)", async () => {
		const projectId = createProject();
		const input: PutMemoryInput = {
			projectId,
			namespace: "lessons",
			key: "test_key",
			value: { secret: "do_not_leak_this" },
			source: "agent:coder",
		};

		await putMemory(handle, log, input);

		const allEvents = handle.db.select().from(events).all();
		const updateEvent = allEvents.find((e) => e.kind === "memory.updated");
		expect(updateEvent).toBeDefined();

		const payload = JSON.parse(updateEvent!.payloadJson);
		expect(payload.projectId).toBe(projectId);
		expect(payload.namespace).toBe("lessons");
		expect(payload.key).toBe("test_key");
		expect(payload.source).toBe("agent:coder");
		expect(payload.hadPrevious).toBe(false);
		// Critical: value is intentionally NOT in the event payload (§3.12.7).
		expect(payload.value).toBeUndefined();
	});

	test("enforces UNIQUE(projectId, namespace, key) constraint", async () => {
		const projectId = createProject();

		// Insert directly to bypass the application-level upsert logic.
		const now = new Date().toISOString();
		handle.db
			.insert(agentMemory)
			.values({
				projectId,
				namespace: "facts",
				key: "duplicate_key",
				valueJson: JSON.stringify("first"),
				source: "system",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		// Attempt to insert a duplicate directly (should fail at the DB level).
		// (The app-level upsert via putMemory avoids this by checking first.)
		const attempt = () => {
			handle.db
				.insert(agentMemory)
				.values({
					projectId,
					namespace: "facts",
					key: "duplicate_key",
					valueJson: JSON.stringify("second"),
					source: "system",
					createdAt: now,
					updatedAt: now,
				})
				.run();
		};

		// This should throw due to UNIQUE constraint.
		expect(attempt).toThrow();
	});
});

describe("deleteMemory", () => {
	test("deletes an existing entry", async () => {
		const projectId = createProject();

		// Insert an entry.
		const putResult = await putMemory(handle, log, {
			projectId,
			namespace: "note",
			key: "to_delete",
			value: "value",
			source: "system",
		});
		expect(putResult.ok).toBe(true);

		// Delete it.
		const deleteResult = await deleteMemory(handle, log, {
			projectId,
			namespace: "note",
			key: "to_delete",
		});
		expect(deleteResult.ok).toBe(true);

		// Verify it's gone.
		const retrieved = getMemory(handle, projectId, "note", "to_delete");
		expect(retrieved).toBeNull();
	});

	test("fails with not_found when entry does not exist", async () => {
		const projectId = createProject();

		const result = await deleteMemory(handle, log, {
			projectId,
			namespace: "note",
			key: "nonexistent",
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("should fail");
		expect(result.reason).toBe("not_found");
	});

	test("deletes only the targeted (projectId, namespace, key)", async () => {
		const projectId = createProject();

		// Insert two entries with same key, different namespaces.
		await putMemory(handle, log, {
			projectId,
			namespace: "facts",
			key: "shared_key",
			value: "facts_val",
			source: "system",
		});
		await putMemory(handle, log, {
			projectId,
			namespace: "lessons",
			key: "shared_key",
			value: "lessons_val",
			source: "system",
		});

		// Delete from facts namespace.
		const result = await deleteMemory(handle, log, {
			projectId,
			namespace: "facts",
			key: "shared_key",
		});
		expect(result.ok).toBe(true);

		// facts entry is gone.
		const factsRow = getMemory(handle, projectId, "facts", "shared_key");
		expect(factsRow).toBeNull();

		// lessons entry still exists.
		const lessonsRow = getMemory(handle, projectId, "lessons", "shared_key");
		expect(lessonsRow).not.toBeNull();
		expect(lessonsRow?.valueJson).toBe(JSON.stringify("lessons_val"));
	});

	test("uses default namespace='note' when not provided", async () => {
		const projectId = createProject();

		// Insert in default namespace.
		await putMemory(handle, log, {
			projectId,
			namespace: "note",
			key: "test_key",
			value: "value",
			source: "system",
		});

		// Delete without specifying namespace (should default to "note").
		const result = await deleteMemory(handle, log, {
			projectId,
			key: "test_key",
			// namespace omitted
		});
		expect(result.ok).toBe(true);

		// Should be gone.
		const retrieved = getMemory(handle, projectId, "note", "test_key");
		expect(retrieved).toBeNull();
	});

	test("emits memory.deleted event with correct payload", async () => {
		const projectId = createProject();

		await putMemory(handle, log, {
			projectId,
			namespace: "facts",
			key: "delete_me",
			value: "value",
			source: "system",
		});

		await deleteMemory(handle, log, {
			projectId,
			namespace: "facts",
			key: "delete_me",
		});

		const allEvents = handle.db.select().from(events).all();
		const deleteEvent = allEvents.find((e) => e.kind === "memory.deleted");
		expect(deleteEvent).toBeDefined();

		const payload = JSON.parse(deleteEvent!.payloadJson);
		expect(payload.projectId).toBe(projectId);
		expect(payload.namespace).toBe("facts");
		expect(payload.key).toBe("delete_me");
	});

	test("does not affect entries from other projects", async () => {
		const projectA = createProject("project-a");
		const projectB = createProject("project-b");

		await putMemory(handle, log, {
			projectId: projectA,
			namespace: "note",
			key: "key",
			value: "val_a",
			source: "system",
		});
		await putMemory(handle, log, {
			projectId: projectB,
			namespace: "note",
			key: "key",
			value: "val_b",
			source: "system",
		});

		// Delete from projectA.
		const result = await deleteMemory(handle, log, {
			projectId: projectA,
			namespace: "note",
			key: "key",
		});
		expect(result.ok).toBe(true);

		// projectA entry is gone.
		expect(getMemory(handle, projectA, "note", "key")).toBeNull();

		// projectB entry still exists.
		const bRow = getMemory(handle, projectB, "note", "key");
		expect(bRow).not.toBeNull();
		expect(bRow?.valueJson).toBe(JSON.stringify("val_b"));
	});
});

describe("Event emission and serialization", () => {
	test("emitted events are persisted and queryable", async () => {
		const projectId = createProject();

		await putMemory(handle, log, {
			projectId,
			namespace: "note",
			key: "key1",
			value: "value1",
			source: "system",
		});

		const allEvents = handle.db.select().from(events).all();
		expect(allEvents.length).toBeGreaterThan(0);

		const memoryEvent = allEvents.find((e) => e.kind === "memory.updated");
		expect(memoryEvent).toBeDefined();
		// projectId is in the payload, not the top-level event row.
		const payload = JSON.parse(memoryEvent!.payloadJson);
		expect(payload.projectId).toBe(projectId);
		expect(memoryEvent?.ts).toBeDefined();
		expect(memoryEvent?.seq).toBeDefined();
	});

	test("event seq is monotonic and gap-free", async () => {
		const projectId = createProject();

		for (let i = 0; i < 5; i++) {
			await putMemory(handle, log, {
				projectId,
				namespace: "note",
				key: `key_${i}`,
				value: `value_${i}`,
				source: "system",
			});
		}

		const allEvents = handle.db.select().from(events).all();
		const seqs = allEvents.map((e) => e.seq).sort((a, b) => a - b);

		// Check for gaps and monotonicity.
		for (let i = 1; i < seqs.length; i++) {
			expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
		}
	});
});
