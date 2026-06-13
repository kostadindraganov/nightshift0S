/**
 * Chat-trigger tests (UNIT B-3 — BLUEPRINT §3.2, §3.10 item 3, §3.12.6).
 *
 * Coverage matrix:
 *   1. processChatUpdate: fail-closed gauntlet (not_found, wrong_kind, bad_token
 *      authz parsing, token verify, allowlist, dedupe, rate-limit).
 *   2. Happy path: allowlisted chat/user with valid token → creates backlog task.
 *   3. Dedupe by update_id within dedupeWindowSeconds.
 *   4. Rate limit blocks on >= rateLimitPerHour.
 *   5. Secret token never appears in returned reason or event payload (hygiene).
 *   6. dry_run_default honored (returns dry_run_pending).
 *   7. Routes layer: POST /chat/telegram/:triggerId parses JSON, reads header,
 *      calls processChatUpdate, returns json/jsonError.
 *
 * All side-effects faked: in-memory SQLite (runMigrations), real EventLog,
 * no network. Each test owns its own DB.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { events, projects, tasks, triggers } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { processChatUpdate, type ProcessChatInput } from "./chat.ts";
import { createRoutine } from "./routines.ts";
import { createTrigger } from "./triggers.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/** Helper: create a project + routine + chat trigger. */
async function setupChatTrigger(authzJson?: string) {
	const proj = handle.db
		.insert(projects)
		.values({
			name: "test-project",
			repoUrl: "https://example.com/repo",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.returning()
		.get();

	const routine = await createRoutine(handle, log, {
		projectId: proj.id,
		name: "test-routine",
		kind: "task",
		promptName: "test-prompt",
	});
	if (!routine.ok) throw new Error(`Failed to create routine: ${routine.reason}`);

	const trigger = await createTrigger(
		{ handle, log },
		{
			routineId: routine.routine.id,
			kind: "chat",
			authzJson,
			dryRunDefault: false,
		},
	);
	if (!trigger.ok) throw new Error(`Failed to create trigger: ${trigger.reason}`);

	return { proj, routine: routine.routine, trigger: trigger.trigger };
}

// ---------------------------------------------------------------------------
// 1. processChatUpdate: fail-closed gauntlet
// ---------------------------------------------------------------------------

test("processChatUpdate: not_found on missing trigger (404)", async () => {
	const result = await processChatUpdate(
		{ handle, log },
		999,
		{
			update: { update_id: 1 },
			secretToken: "token",
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("not_found");
	expect(result.status).toBe(404);
});

test("processChatUpdate: wrong_kind on non-chat trigger (400)", async () => {
	const { trigger: chatTrigger } = await setupChatTrigger();
	// Manually change kind to 'manual' to test the guard.
	handle.db
		.update(triggers)
		.set({ kind: "manual" })
		.where(eq(triggers.id, chatTrigger.id))
		.run();

	const result = await processChatUpdate(
		{ handle, log },
		chatTrigger.id,
		{
			update: { update_id: 1 },
			secretToken: "token",
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("wrong_kind");
	expect(result.status).toBe(400);
});

test("processChatUpdate: bad_token on corrupt authz_json (401)", async () => {
	const { routine } = await setupChatTrigger();
	const row = handle.db
		.insert(triggers)
		.values({
			routineId: routine.id,
			kind: "chat",
			authzJson: "{not-valid-json",
			enabled: true,
		})
		.returning()
		.get();

	const result = await processChatUpdate(
		{ handle, log },
		row.id,
		{
			update: { update_id: 1 },
			secretToken: "token",
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("bad_token");
	expect(result.status).toBe(401);
	// Ensure the corrupt authz blob is not leaked.
	expect(result.reason).not.toContain("{not-valid");
});

test("processChatUpdate: bad_token when authz_json is an array (401)", async () => {
	const { routine } = await setupChatTrigger();
	const row = handle.db
		.insert(triggers)
		.values({
			routineId: routine.id,
			kind: "chat",
			authzJson: '["not", "an", "object"]',
			enabled: true,
		})
		.returning()
		.get();

	const result = await processChatUpdate(
		{ handle, log },
		row.id,
		{
			update: { update_id: 1 },
			secretToken: "token",
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("bad_token");
	expect(result.status).toBe(401);
});

test("processChatUpdate: bad_token when no secretToken is configured (fail-closed, 401)", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			// No secretToken field
			allowChatIds: [123],
		}),
	);

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: 1, message: { chat: { id: 123 } } },
			secretToken: "any-token",
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("bad_token");
	expect(result.status).toBe(401);
});

test("processChatUpdate: bad_token when secretToken is empty string (fail-closed, 401)", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "",
			allowChatIds: [123],
		}),
	);

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: 1, message: { chat: { id: 123 } } },
			secretToken: "some-token",
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("bad_token");
	expect(result.status).toBe(401);
});

test("processChatUpdate: bad_token when provided token does not match configured secret (401)", async () => {
	const secretToken = "my-secret-token";
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken,
			allowChatIds: [123],
		}),
	);

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: 1, message: { chat: { id: 123 } } },
			secretToken: "wrong-token",
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("bad_token");
	expect(result.status).toBe(401);
	// The secret token must NOT appear in the reason.
	expect(result.reason).not.toContain(secretToken);
	expect(result.reason).not.toContain("my-secret");
});

test("processChatUpdate: bad_token when secretToken header is null/absent (401)", async () => {
	const secretToken = "required-token";
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken,
			allowChatIds: [123],
		}),
	);

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: 1, message: { chat: { id: 123 } } },
			secretToken: null, // No header provided
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("bad_token");
	expect(result.status).toBe(401);
});

test("processChatUpdate: authz_denied when neither chatId nor username are allowlisted (403)", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowChatIds: [123, 456],
			allowUsernames: ["alice", "bob"],
		}),
	);

	// Message has chat.id=999 (not in allowChatIds) and no username.
	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: {
				update_id: 1,
				message: { chat: { id: 999 } }, // Not in the list
			},
			secretToken: "my-token",
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("authz_denied");
	expect(result.status).toBe(403);
});

test("processChatUpdate: authz_denied when username not in allowlist (403)", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowChatIds: [123],
			allowUsernames: ["alice"],
		}),
	);

	// Message has a username not in the allowlist.
	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: {
				update_id: 1,
				message: {
					chat: { id: 999 }, // Not allowed
					from: { id: 42, username: "charlie" }, // Not in allowUsernames
				},
			},
			secretToken: "my-token",
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("authz_denied");
	expect(result.status).toBe(403);
});

test("processChatUpdate: authz_denied when allowChatIds and allowUsernames are both empty/absent (fail-closed, 403)", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			// No allowChatIds, no allowUsernames → empty allow list = deny all
		}),
	);

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: {
				update_id: 1,
				message: {
					chat: { id: 123 },
					from: { id: 42, username: "alice" },
				},
			},
			secretToken: "my-token",
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("authz_denied");
	expect(result.status).toBe(403);
});

test("processChatUpdate: duplicate when update_id repeats within dedupeWindowSeconds (409)", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowChatIds: [123],
			allowlist: ["chat:123"],
			dedupeWindowSeconds: 60,
		}),
	);

	const updateId = 42;

	// First fire with update_id=42 succeeds.
	const first = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: {
				update_id: updateId,
				message: { chat: { id: 123 } },
			},
			secretToken: "my-token",
		},
	);
	expect(first.ok).toBe(true);

	// Same update_id immediately → duplicate.
	const second = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: {
				update_id: updateId,
				message: { chat: { id: 123 } },
			},
			secretToken: "my-token",
		},
	);

	expect(second.ok).toBe(false);
	if (second.ok) return;
	expect(second.reason).toBe("duplicate");
	expect(second.status).toBe(409);
});

test("processChatUpdate: rate_limited when >= rateLimitPerHour (429)", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowChatIds: [123],
			allowlist: ["chat:123"],
			rateLimitPerHour: 2,
		}),
	);

	// First fire succeeds.
	const first = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: 1, message: { chat: { id: 123 } } },
			secretToken: "my-token",
		},
	);
	expect(first.ok).toBe(true);

	// Second fire succeeds.
	const second = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: 2, message: { chat: { id: 123 } } },
			secretToken: "my-token",
		},
	);
	expect(second.ok).toBe(true);

	// Third fire → rate limited (at the limit already).
	const third = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: 3, message: { chat: { id: 123 } } },
			secretToken: "my-token",
		},
	);

	expect(third.ok).toBe(false);
	if (third.ok) return;
	expect(third.reason).toBe("rate_limited");
	expect(third.status).toBe(429);
});

// ---------------------------------------------------------------------------
// 2. processChatUpdate: happy path - creates backlog task
// ---------------------------------------------------------------------------

test("processChatUpdate: happy path with allowlisted chatId creates task", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowChatIds: [123],
			allowlist: ["chat:123"],
		}),
	);

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: {
				update_id: 42,
				message: { chat: { id: 123 }, from: { id: 99 } },
			},
			secretToken: "my-token",
		},
	);

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.taskId).toBeGreaterThan(0);

	// Verify the task was created in the DB.
	const task = handle.db
		.select()
		.from(tasks)
		.where(eq(tasks.id, result.taskId))
		.get();
	expect(task).toBeDefined();
	expect(task?.state).toBe("backlog");
});

test("processChatUpdate: happy path with allowlisted username creates task", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowUsernames: ["alice"],
			allowlist: ["chat:alice"],
		}),
	);

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: {
				update_id: 42,
				message: {
					chat: { id: 999 },
					from: { id: 1, username: "alice" },
				},
			},
			secretToken: "my-token",
		},
	);

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.taskId).toBeGreaterThan(0);

	const task = handle.db
		.select()
		.from(tasks)
		.where(eq(tasks.id, result.taskId))
		.get();
	expect(task).toBeDefined();
	expect(task?.state).toBe("backlog");
});

test("processChatUpdate: happy path with both chatId and username allowed", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowChatIds: [123],
			allowUsernames: ["alice"],
			allowlist: ["chat:alice"],
		}),
	);

	// Both chatId and username are allowlisted. Actor is preferring username.
	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: {
				update_id: 42,
				message: {
					chat: { id: 123 },
					from: { id: 1, username: "alice" },
				},
			},
			secretToken: "my-token",
		},
	);

	expect(result.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// 3. processChatUpdate: dry_run_default honored
// ---------------------------------------------------------------------------

test("processChatUpdate: respects dry_run_default (409, no task created)", async () => {
	const { routine } = await setupChatTrigger();
	const row = handle.db
		.insert(triggers)
		.values({
			routineId: routine.id,
			kind: "chat",
			authzJson: JSON.stringify({
				secretToken: "my-token",
				allowChatIds: [123],
				allowlist: ["chat:123"],
			}),
			enabled: true,
			dryRunDefault: true, // <-- The key flag
		})
		.returning()
		.get();

	const result = await processChatUpdate(
		{ handle, log },
		row.id,
		{
			update: { update_id: 1, message: { chat: { id: 123 } } },
			secretToken: "my-token",
		},
	);

	// Should return dry_run_pending, not ok.
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("dry_run_pending");
	expect(result.status).toBe(409);

	// No task should be created.
	const allTasks = handle.db.select().from(tasks).all();
	expect(allTasks.length).toBe(0);
});

// ---------------------------------------------------------------------------
// 4. Secret token hygiene: never leak in reasons or event payloads
// ---------------------------------------------------------------------------

test("processChatUpdate: secret token never appears in bad_token reason", async () => {
	const secretToken = "super-secret-key-12345";
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken,
			allowChatIds: [123],
			allowlist: ["chat:123"],
		}),
	);

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: 1, message: { chat: { id: 123 } } },
			secretToken: "wrong-token",
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).not.toContain("super-secret");
	expect(result.reason).not.toContain("secret-key");
	expect(result.reason).not.toContain("12345");
});

test("processChatUpdate: secret token never appears in authz_denied reason", async () => {
	const secretToken = "my-secret-xyz";
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken,
			allowChatIds: [123],
			allowlist: ["chat:123"],
		}),
	);

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: {
				update_id: 1,
				message: { chat: { id: 999 } }, // Not in allowlist
			},
			secretToken: secretToken,
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).not.toContain(secretToken);
	expect(result.reason).not.toContain("my-secret");
});

test("processChatUpdate success: emitted event has no secrets", async () => {
	const secretToken = "my-token";
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken,
			allowChatIds: [123],
			allowlist: ["chat:123"],
		}),
	);

	// Clear events and fire.
	handle.db.delete(events).run();

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: {
				update_id: 42,
				message: { chat: { id: 123 } },
			},
			secretToken,
		},
	);

	expect(result.ok).toBe(true);

	// Check the trigger.fired event.
	const firedEvent = handle.db
		.select()
		.from(events)
		.where(eq(events.kind, "trigger.fired"))
		.get();

	expect(firedEvent).toBeDefined();
	if (firedEvent) {
		const payload = JSON.parse(firedEvent.payloadJson) as Record<string, unknown>;
		// No secretToken, secret, or authzJson should appear.
		expect(Object.keys(payload)).not.toContain("secretToken");
		expect(Object.keys(payload)).not.toContain("secret");
		expect(Object.keys(payload)).not.toContain("authzJson");
		// But the dedupeKey (update_id as string) should be present.
		expect(payload.dedupeKey).toBe("42");
	}
});

// ---------------------------------------------------------------------------
// 5. Dedupe and rate-limit edge cases
// ---------------------------------------------------------------------------

test("processChatUpdate: dedupeWindowSeconds:0 disables dedupe", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowChatIds: [123],
			allowlist: ["chat:123"],
			dedupeWindowSeconds: 0, // Disabled
		}),
	);

	const updateId = 42;

	const first = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: updateId, message: { chat: { id: 123 } } },
			secretToken: "my-token",
		},
	);
	expect(first.ok).toBe(true);

	// Same update_id but dedupe is disabled.
	const second = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: updateId, message: { chat: { id: 123 } } },
			secretToken: "my-token",
		},
	);
	expect(second.ok).toBe(true); // No duplicate error.
});

test("processChatUpdate: rateLimitPerHour:0 blocks all (fail-closed)", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowChatIds: [123],
			allowlist: ["chat:123"],
			rateLimitPerHour: 0,
		}),
	);

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: 1, message: { chat: { id: 123 } } },
			secretToken: "my-token",
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("rate_limited");
});

test("processChatUpdate: authz without limits defaults to unlimited", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowChatIds: [123],
			allowlist: ["chat:123"],
			// No dedupeWindowSeconds, no rateLimitPerHour
		}),
	);

	// Multiple fires with different update_ids should succeed (no limits).
	for (let i = 0; i < 5; i++) {
		const result = await processChatUpdate(
			{ handle, log },
			trigger.id,
			{
				update: { update_id: i, message: { chat: { id: 123 } } },
				secretToken: "my-token",
			},
		);
		expect(result.ok).toBe(true);
	}
});

// ---------------------------------------------------------------------------
// 6. Edge cases: missing message, no username/chat, etc.
// ---------------------------------------------------------------------------

test("processChatUpdate: authz_denied when update has no message (403)", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowChatIds: [123],
		}),
	);

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: 1 }, // No message field
			secretToken: "my-token",
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("authz_denied");
	expect(result.status).toBe(403);
});

test("processChatUpdate: authz_denied when from.username not in allowUsernames (403)", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowUsernames: ["alice"],
		}),
	);

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: {
				update_id: 1,
				message: {
					chat: { id: 999 },
					from: { id: 1, username: "bob" }, // Username not in allowlist
				},
			},
			secretToken: "my-token",
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("authz_denied");
});

test("processChatUpdate: gauntlet order - token checked before allowlist", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowChatIds: [123],
			allowlist: ["chat:123"],
		}),
	);

	// Wrong token should yield bad_token (401), not authz_denied (403).
	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: 1, message: { chat: { id: 123 } } },
			secretToken: "wrong-token",
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("bad_token");
	expect(result.status).toBe(401);
});

test("processChatUpdate: gauntlet order - allowlist checked before dedupe", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowChatIds: [123],
			allowlist: ["chat:123"],
			dedupeWindowSeconds: 60,
		}),
	);

	// First, fire a valid update.
	const first = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: 42, message: { chat: { id: 123 } } },
			secretToken: "my-token",
		},
	);
	expect(first.ok).toBe(true);

	// Now, try to fire with a different update_id from a non-allowlisted chat.
	// Even though the update_id differs, the allowlist gate should fire first.
	const second = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: 99, message: { chat: { id: 999 } } },
			secretToken: "my-token",
		},
	);

	expect(second.ok).toBe(false);
	if (second.ok) return;
	// Allowlist gate fires before dedupe, so we should get authz_denied.
	expect(second.reason).toBe("authz_denied");
});

// ---------------------------------------------------------------------------
// 7. Constant-time token comparison (basic sanity)
// ---------------------------------------------------------------------------

test("processChatUpdate: token length mismatch is rejected", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-secret-token",
			allowChatIds: [123],
			allowlist: ["chat:123"],
		}),
	);

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: { update_id: 1, message: { chat: { id: 123 } } },
			secretToken: "short", // Different length
		},
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("bad_token");
});

// ---------------------------------------------------------------------------
// 8. Actor encoding in fired event
// ---------------------------------------------------------------------------

test("processChatUpdate: fired event actor encodes username when available", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowUsernames: ["alice"],
			allowlist: ["chat:alice"],
		}),
	);

	handle.db.delete(events).run();

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: {
				update_id: 42,
				message: {
					chat: { id: 999 },
					from: { id: 1, username: "alice" },
				},
			},
			secretToken: "my-token",
		},
	);

	expect(result.ok).toBe(true);

	const firedEvent = handle.db
		.select()
		.from(events)
		.where(eq(events.kind, "trigger.fired"))
		.get();

	expect(firedEvent).toBeDefined();
	if (firedEvent) {
		const payload = JSON.parse(firedEvent.payloadJson) as Record<string, unknown>;
		expect(payload.actor).toBe("chat:alice");
	}
});

test("processChatUpdate: fired event actor encodes chatId when no username", async () => {
	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowChatIds: [123],
			allowlist: ["chat:123"],
		}),
	);

	handle.db.delete(events).run();

	const result = await processChatUpdate(
		{ handle, log },
		trigger.id,
		{
			update: {
				update_id: 42,
				message: {
					chat: { id: 123 },
					from: { id: 1 }, // No username
				},
			},
			secretToken: "my-token",
		},
	);

	expect(result.ok).toBe(true);

	const firedEvent = handle.db
		.select()
		.from(events)
		.where(eq(events.kind, "trigger.fired"))
		.get();

	expect(firedEvent).toBeDefined();
	if (firedEvent) {
		const payload = JSON.parse(firedEvent.payloadJson) as Record<string, unknown>;
		expect(payload.actor).toBe("chat:123");
	}
});

// ---------------------------------------------------------------------------
// 9. Routes layer: POST /chat/telegram/:triggerId
// ---------------------------------------------------------------------------

test("chatRoutes: POST /chat/telegram/:triggerId returns 400 on non-integer triggerId", async () => {
	const { chatRoutes } = await import("./chatRoutes.ts");
	const route = chatRoutes.find((r) => r.path === "/chat/telegram/:triggerId");
	expect(route).toBeDefined();
	expect(route?.auth).toBe(false);

	const url = new URL("http://localhost/chat/telegram/abc");
	const req = new Request(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ update_id: 1 }),
	});
	const ctx = { req, url, params: { triggerId: "abc" }, handle, events: log };
	const res = await route!.handler(ctx as any);
	expect(res.status).toBe(400);
	const body = await res.json() as Record<string, unknown>;
	expect((body.error as Record<string, unknown>).code).toBe("invalid_input");
});

test("chatRoutes: POST /chat/telegram/:triggerId returns 400 on bad JSON body", async () => {
	const { chatRoutes } = await import("./chatRoutes.ts");
	const route = chatRoutes.find((r) => r.path === "/chat/telegram/:triggerId");
	expect(route).toBeDefined();

	const url = new URL("http://localhost/chat/telegram/1");
	const req = new Request(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "not-json",
	});
	const ctx = { req, url, params: { triggerId: "1" }, handle, events: log };
	const res = await route!.handler(ctx as any);
	expect(res.status).toBe(400);
	const body = await res.json() as Record<string, unknown>;
	expect((body.error as Record<string, unknown>).code).toBe("invalid_input");
});

test("chatRoutes: POST /chat/telegram/:triggerId reads x-telegram-bot-api-secret-token header and returns 404 on missing trigger", async () => {
	const { chatRoutes } = await import("./chatRoutes.ts");
	const route = chatRoutes.find((r) => r.path === "/chat/telegram/:triggerId");
	expect(route).toBeDefined();

	const url = new URL("http://localhost/chat/telegram/999");
	const req = new Request(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-telegram-bot-api-secret-token": "some-token",
		},
		body: JSON.stringify({ update_id: 1 }),
	});
	const ctx = { req, url, params: { triggerId: "999" }, handle, events: log };
	const res = await route!.handler(ctx as any);
	expect(res.status).toBe(404);
	const body = await res.json() as Record<string, unknown>;
	expect((body.error as Record<string, unknown>).code).toBe("not_found");
});

test("chatRoutes: POST /chat/telegram/:triggerId returns 401 when bad token", async () => {
	const { chatRoutes } = await import("./chatRoutes.ts");
	const route = chatRoutes.find((r) => r.path === "/chat/telegram/:triggerId");
	expect(route).toBeDefined();

	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "correct-token",
			allowChatIds: [123],
			allowlist: ["chat:123"],
		}),
	);

	const url = new URL(`http://localhost/chat/telegram/${trigger.id}`);
	const req = new Request(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-telegram-bot-api-secret-token": "wrong-token",
		},
		body: JSON.stringify({ update_id: 1, message: { chat: { id: 123 } } }),
	});
	const ctx = { req, url, params: { triggerId: String(trigger.id) }, handle, events: log };
	const res = await route!.handler(ctx as any);
	expect(res.status).toBe(401);
	const body = await res.json() as Record<string, unknown>;
	const err = body.error as Record<string, unknown>;
	expect(err.code).toBe("bad_token");
	// The route must NOT echo the token in the response.
	expect(JSON.stringify(body)).not.toContain("correct-token");
	expect(JSON.stringify(body)).not.toContain("wrong-token");
});

test("chatRoutes: POST /chat/telegram/:triggerId happy path returns 201 with task_id", async () => {
	const { chatRoutes } = await import("./chatRoutes.ts");
	const route = chatRoutes.find((r) => r.path === "/chat/telegram/:triggerId");
	expect(route).toBeDefined();

	const { trigger } = await setupChatTrigger(
		JSON.stringify({
			secretToken: "my-token",
			allowChatIds: [123],
			allowlist: ["chat:123"],
		}),
	);

	const url = new URL(`http://localhost/chat/telegram/${trigger.id}`);
	const req = new Request(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-telegram-bot-api-secret-token": "my-token",
		},
		body: JSON.stringify({ update_id: 42, message: { chat: { id: 123 } } }),
	});
	const ctx = { req, url, params: { triggerId: String(trigger.id) }, handle, events: log };
	const res = await route!.handler(ctx as any);
	expect(res.status).toBe(201);
	const body = await res.json() as Record<string, unknown>;
	expect(body.ok).toBe(true);
	expect(typeof body.task_id).toBe("number");
	expect((body.task_id as number)).toBeGreaterThan(0);
});
