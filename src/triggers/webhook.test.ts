/**
 * Webhook triggers tests (UNIT P6-3 — BLUEPRINT §3.2, §3.10 item 3, §3.12.6).
 *
 * Coverage matrix:
 *   1. verifyWebhookSignature: true on correct HMAC, false on tampered/missing.
 *   2. processWebhook: bad_signature when sig is wrong; honors dry_run_default.
 *   3. Creates backlog task on valid signed delivery.
 *   4. Dedupe + rate-limit paths block fires.
 *   5. The secret is never leaked in any returned reason or event payload.
 *
 * All side-effects faked: in-memory SQLite (runMigrations), real EventLog,
 * injected HMAC + fireTrigger. No network.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { events, projects, tasks, triggers } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import {
	processWebhook,
	verifyWebhookSignature,
	type ProcessWebhookDeps,
} from "./webhook.ts";
import { createRoutine } from "./routines.ts";
import { createTrigger } from "./triggers.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let handle: DbHandle;
let log: EventLog;
let deps: ProcessWebhookDeps;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
	deps = { handle, log };
});

afterEach(() => {
	handle.sqlite.close();
});

/** Helper: create a project + routine + webhook trigger. */
async function setupWebhookTrigger(authzJson?: string) {
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
			kind: "webhook",
			authzJson,
			dryRunDefault: false,
		},
	);
	if (!trigger.ok) throw new Error(`Failed to create trigger: ${trigger.reason}`);

	return { proj, routine: routine.routine, trigger: trigger.trigger };
}

/** Helper: compute HMAC-SHA256 of payload keyed by secret, return as hex. */
function computeHmac(secret: string, payload: string): string {
	return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Helper: compute HMAC with sha256= prefix (GitHub style). */
function computeHmacGithubStyle(secret: string, payload: string): string {
	return `sha256=${computeHmac(secret, payload)}`;
}

// ---------------------------------------------------------------------------
// 1. verifyWebhookSignature: happy path + fail-closed
// ---------------------------------------------------------------------------

test("verifyWebhookSignature: accepts correct HMAC (hex)", () => {
	const secret = "my-secret";
	const payload = '{"action":"opened"}';
	const hmac = computeHmac(secret, payload);

	expect(verifyWebhookSignature(secret, payload, hmac)).toBe(true);
});

test("verifyWebhookSignature: accepts correct HMAC (sha256= prefix)", () => {
	const secret = "my-secret";
	const payload = '{"action":"opened"}';
	const hmac = computeHmacGithubStyle(secret, payload);

	expect(verifyWebhookSignature(secret, payload, hmac)).toBe(true);
});

test("verifyWebhookSignature: rejects tampered signature", () => {
	const secret = "my-secret";
	const payload = '{"action":"opened"}';
	const hmac = computeHmac(secret, payload);
	const tampered = hmac.slice(0, -2) + "XX"; // corrupt last 2 chars

	expect(verifyWebhookSignature(secret, payload, tampered)).toBe(false);
});

test("verifyWebhookSignature: rejects missing signature (null)", () => {
	const secret = "my-secret";
	const payload = '{"action":"opened"}';

	expect(verifyWebhookSignature(secret, payload, null)).toBe(false);
});

test("verifyWebhookSignature: rejects empty signature", () => {
	const secret = "my-secret";
	const payload = '{"action":"opened"}';

	expect(verifyWebhookSignature(secret, payload, "")).toBe(false);
});

test("verifyWebhookSignature: rejects wrong-length hex", () => {
	const secret = "my-secret";
	const payload = '{"action":"opened"}';
	const wrongLen = "aabbccdd"; // not 64 chars

	expect(verifyWebhookSignature(secret, payload, wrongLen)).toBe(false);
});

test("verifyWebhookSignature: rejects non-hex signature", () => {
	const secret = "my-secret";
	const payload = '{"action":"opened"}';
	const notHex = "z".repeat(64); // invalid hex chars

	expect(verifyWebhookSignature(secret, payload, notHex)).toBe(false);
});

test("verifyWebhookSignature: rejects signature of wrong HMAC algorithm", () => {
	// Simulating a signature computed with a different algorithm.
	const secret = "my-secret";
	const payload = '{"action":"opened"}';
	const wrongAlgo = createHmac("sha1", secret).update(payload).digest("hex");

	expect(verifyWebhookSignature(secret, payload, wrongAlgo)).toBe(false);
});

// ---------------------------------------------------------------------------
// 2. processWebhook: the fail-closed gauntlet
// ---------------------------------------------------------------------------

test("processWebhook: not_found on missing trigger (404)", async () => {
	const result = await processWebhook(deps, 999, {
		rawBody: "body",
		signature: "ignored",
	});

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("not_found");
	expect(result.status).toBe(404);
});

test("processWebhook: wrong_kind when trigger is not webhook (400)", async () => {
	const { trigger: manualTrigger } = await setupWebhookTrigger();
	// Manually change kind to 'manual' to test the guard.
	handle.db
		.update(triggers)
		.set({ kind: "manual" })
		.where(eq(triggers.id, manualTrigger.id))
		.run();

	const result = await processWebhook(deps, manualTrigger.id, {
		rawBody: "body",
		signature: null,
	});

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("wrong_kind");
	expect(result.status).toBe(400);
});

test("processWebhook: bad_signature when authz is corrupt JSON (401)", async () => {
	// Create a webhook trigger with corrupt authz by writing directly.
	const { routine } = await setupWebhookTrigger();
	const row = handle.db
		.insert(triggers)
		.values({
			routineId: routine.id,
			kind: "webhook",
			authzJson: "{not-valid-json",
			enabled: true,
		})
		.returning()
		.get();

	const secret = "any-secret";
	const payload = '{"data":"test"}';
	const hmac = computeHmac(secret, payload);

	const result = await processWebhook(deps, row.id, {
		rawBody: payload,
		signature: hmac,
	});

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("bad_signature");
	expect(result.status).toBe(401);
	// Ensure the corrupt authz blob is not leaked.
	expect(result.reason).not.toContain("{not-valid");
});

test("processWebhook: bad_signature when signature verification fails (401)", async () => {
	const secret = "my-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({ secret, allowlist: ["webhook"] }),
	);

	const payload = '{"action":"opened"}';
	const wrongSig = "a".repeat(64); // wrong HMAC

	const result = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: wrongSig,
	});

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("bad_signature");
	expect(result.status).toBe(401);
	// The secret must NOT appear in the reason.
	expect(result.reason).not.toContain(secret);
});

test("processWebhook: bad_signature when no secret is configured (401)", async () => {
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({ allowlist: ["webhook"] }), // no secret
	);

	const payload = '{"action":"opened"}';
	const anyHmac = computeHmac("dummy-secret", payload);

	const result = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: anyHmac,
	});

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("bad_signature");
	expect(result.status).toBe(401);
});

test("processWebhook: duplicate when deliveryId repeats within dedupeWindowSeconds (409)", async () => {
	const secret = "my-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({
			secret,
			allowlist: ["webhook"],
			dedupeWindowSeconds: 60,
		}),
	);

	const payload = '{"action":"opened"}';
	const hmac = computeHmac(secret, payload);

	// First delivery succeeds.
	const first = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
		deliveryId: "delivery-1",
	});
	expect(first.ok).toBe(true);

	// Same deliveryId immediately → duplicate.
	const second = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
		deliveryId: "delivery-1",
	});

	expect(second.ok).toBe(false);
	if (second.ok) return;
	expect(second.reason).toBe("duplicate");
	expect(second.status).toBe(409);
});

test("processWebhook: rate_limited when >= rateLimitPerHour (429)", async () => {
	const secret = "my-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({
			secret,
			allowlist: ["webhook"],
			rateLimitPerHour: 1,
		}),
	);

	const payload = '{"action":"opened"}';
	const hmac = computeHmac(secret, payload);

	// First fire succeeds.
	const first = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
	});
	expect(first.ok).toBe(true);

	// Second fire → rate limited.
	const second = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
	});

	expect(second.ok).toBe(false);
	if (second.ok) return;
	expect(second.reason).toBe("rate_limited");
	expect(second.status).toBe(429);
});

// ---------------------------------------------------------------------------
// 3. processWebhook: happy path - creates backlog task
// ---------------------------------------------------------------------------

test("processWebhook: happy path creates task and returns taskId", async () => {
	const secret = "my-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({
			secret,
			allowlist: ["webhook"],
		}),
	);

	const payload = '{"action":"opened","number":42}';
	const hmac = computeHmac(secret, payload);

	const result = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
		deliveryId: "delivery-xyz",
	});

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

test("processWebhook: respects dry_run_default (409, no task created)", async () => {
	// Create a trigger with dry_run_default set.
	const { routine } = await setupWebhookTrigger();
	const secret = "my-secret";
	const row = handle.db
		.insert(triggers)
		.values({
			routineId: routine.id,
			kind: "webhook",
			authzJson: JSON.stringify({
				secret,
				allowlist: ["webhook"],
			}),
			enabled: true,
			dryRunDefault: true, // <-- The key flag
		})
		.returning()
		.get();

	const payload = '{"action":"opened"}';
	const hmac = computeHmac(secret, payload);

	const result = await processWebhook(deps, row.id, {
		rawBody: payload,
		signature: hmac,
	});

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
// 4. Secret hygiene: never leak in reasons or event payloads
// ---------------------------------------------------------------------------

test("processWebhook: secret never appears in bad_signature reason", async () => {
	const secret = "super-secret-key-12345";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({ secret, allowlist: ["webhook"] }),
	);

	const payload = '{"action":"opened"}';
	const wrongSig = "b".repeat(64);

	const result = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: wrongSig,
	});

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).not.toContain("super-secret");
	expect(result.reason).not.toContain("secret-key");
});

test("processWebhook: signature is not echoed in any response", async () => {
	const secret = "my-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({ secret, allowlist: ["webhook"] }),
	);

	const payload = '{"action":"opened"}';
	const hmac = computeHmac(secret, payload);
	const wrongSig = "a".repeat(64);

	const result = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: wrongSig,
	});

	expect(result.ok).toBe(false);
	if (result.ok) return;
	// The correct HMAC should not appear in the response.
	expect(result.reason).not.toContain(hmac);
	expect(result.reason).not.toContain(wrongSig);
});

test("processWebhook success: emitted event has no secrets", async () => {
	const secret = "my-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({
			secret,
			allowlist: ["webhook"],
		}),
	);

	const payload = '{"action":"opened"}';
	const hmac = computeHmac(secret, payload);

	// Clear events and fire.
	handle.db.delete(events).run();

	const result = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
		deliveryId: "delivery-xyz",
	});

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
		// No authzJson, secret, or signature should appear.
		expect(Object.keys(payload)).not.toContain("secret");
		expect(Object.keys(payload)).not.toContain("signature");
		expect(Object.keys(payload)).not.toContain("authzJson");
		// But the dedupeKey (deliveryId) should be present for idempotency.
		expect(payload.dedupeKey).toBe("delivery-xyz");
	}
});

// ---------------------------------------------------------------------------
// 5. Edge cases: empty deliveryId, missing windows, etc.
// ---------------------------------------------------------------------------

test("processWebhook: ignores empty deliveryId (dedupe skipped)", async () => {
	const secret = "my-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({
			secret,
			allowlist: ["webhook"],
			dedupeWindowSeconds: 60,
		}),
	);

	const payload = '{"action":"opened"}';
	const hmac = computeHmac(secret, payload);

	// First call with empty deliveryId.
	const first = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
		deliveryId: "",
	});
	expect(first.ok).toBe(true);

	// Second call with same empty deliveryId should NOT trigger dedupe.
	const second = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
		deliveryId: "",
	});
	expect(second.ok).toBe(true); // No duplicate.
});

test("processWebhook: dedupeWindowSeconds:0 disables dedupe", async () => {
	const secret = "my-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({
			secret,
			allowlist: ["webhook"],
			dedupeWindowSeconds: 0, // Disabled
		}),
	);

	const payload = '{"action":"opened"}';
	const hmac = computeHmac(secret, payload);

	const first = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
		deliveryId: "delivery-1",
	});
	expect(first.ok).toBe(true);

	// Same deliveryId but dedupe is disabled.
	const second = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
		deliveryId: "delivery-1",
	});
	expect(second.ok).toBe(true);
});

test("processWebhook: rateLimitPerHour:0 blocks all (fail-closed)", async () => {
	const secret = "my-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({
			secret,
			allowlist: ["webhook"],
			rateLimitPerHour: 0,
		}),
	);

	const payload = '{"action":"opened"}';
	const hmac = computeHmac(secret, payload);

	const result = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
	});

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("rate_limited");
});

test("processWebhook: authz as empty object defaults all limits to unlimited", async () => {
	const secret = "my-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({
			secret,
			allowlist: ["webhook"],
			// No dedupeWindowSeconds, no rateLimitPerHour → all unlimited
		}),
	);

	const payload = '{"action":"opened"}';
	const hmac = computeHmac(secret, payload);

	// Multiple fires should succeed (no limits).
	for (let i = 0; i < 5; i++) {
		const result = await processWebhook(deps, trigger.id, {
			rawBody: payload,
			signature: hmac,
			deliveryId: `delivery-${i}`,
		});
		expect(result.ok).toBe(true);
	}
});

test("processWebhook: secretRef is treated as the secret value", async () => {
	// Tests inject the secret directly for hermeticity; production would resolve
	// the keyring ref. This test verifies that secretRef is used as the secret.
	const secret = "my-secret-from-ref";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({
			secretRef: secret, // using secretRef instead of secret
			allowlist: ["webhook"],
		}),
	);

	const payload = '{"action":"opened"}';
	const hmac = computeHmac(secret, payload);

	const result = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
	});

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.taskId).toBeGreaterThan(0);
});

test("processWebhook: secret takes precedence over secretRef", async () => {
	const secret = "direct-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({
			secret, // Takes precedence
			secretRef: "should-be-ignored",
			allowlist: ["webhook"],
		}),
	);

	const payload = '{"action":"opened"}';
	const hmac = computeHmac(secret, payload);

	const result = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
	});

	expect(result.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// 6. Different signature header formats
// ---------------------------------------------------------------------------

test("processWebhook: accepts plain hex signature (no sha256= prefix)", async () => {
	const secret = "my-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({ secret, allowlist: ["webhook"] }),
	);

	const payload = '{"action":"opened"}';
	const hmac = computeHmac(secret, payload); // plain hex

	const result = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
	});

	expect(result.ok).toBe(true);
});

test("processWebhook: accepts sha256= prefixed signature", async () => {
	const secret = "my-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({ secret, allowlist: ["webhook"] }),
	);

	const payload = '{"action":"opened"}';
	const hmac = computeHmacGithubStyle(secret, payload); // sha256=...

	const result = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
	});

	expect(result.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// 7. Fail-closed: allowlist + authz_denied path
// ---------------------------------------------------------------------------

test("processWebhook: authz_denied when allowlist does not include 'webhook' (403)", async () => {
	// The signature is correct, but the allowlist excludes "webhook" so fireTrigger
	// will refuse at the authz gate. processWebhook must surface this as authz_denied.
	const secret = "my-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({ secret, allowlist: ["github-app"] }), // "webhook" not in list
	);

	const payload = '{"action":"opened"}';
	const hmac = computeHmac(secret, payload);

	const result = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
	});

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("authz_denied");
	expect(result.status).toBe(403);
	// authz config must not be leaked in the reason.
	expect(result.reason).not.toContain("github-app");
	expect(result.reason).not.toContain(secret);
});

test("processWebhook: authz_denied when allowlist is empty (fail-closed, 403)", async () => {
	// Empty allowlist must deny — no actor passes when the allowlist is absent.
	const secret = "my-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({ secret, allowlist: [] }), // empty allowlist = deny all
	);

	const payload = '{"action":"ping"}';
	const hmac = computeHmac(secret, payload);

	const result = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
	});

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe("authz_denied");
	expect(result.status).toBe(403);
});

test("processWebhook: signature is verified BEFORE allowlist (gauntlet order)", async () => {
	// A correct HMAC but empty allowlist should yield authz_denied (not bad_signature),
	// confirming that the HMAC check is a gate and allowlist comes after.
	const secret = "my-secret";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({ secret, allowlist: [] }),
	);

	const payload = '{"action":"ping"}';
	const correctHmac = computeHmac(secret, payload);
	const wrongHmac = "a".repeat(64);

	// Wrong HMAC → bad_signature (HMAC gate fires first).
	const wrongSigResult = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: wrongHmac,
	});
	expect(wrongSigResult.ok).toBe(false);
	if (!wrongSigResult.ok) expect(wrongSigResult.reason).toBe("bad_signature");

	// Correct HMAC, empty allowlist → authz_denied (HMAC passed, allowlist gate fires).
	const correctSigResult = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: correctHmac,
	});
	expect(correctSigResult.ok).toBe(false);
	if (!correctSigResult.ok) expect(correctSigResult.reason).toBe("authz_denied");
});

test("processWebhook: authz_denied reason never contains secret or authz_json content", async () => {
	// Even on authz failure the secret must not leak.
	const secret = "ultra-secret-token-9999";
	const { trigger } = await setupWebhookTrigger(
		JSON.stringify({ secret, allowlist: ["other-actor"] }),
	);

	const payload = "hello";
	const hmac = computeHmac(secret, payload);

	const result = await processWebhook(deps, trigger.id, {
		rawBody: payload,
		signature: hmac,
	});

	expect(result.ok).toBe(false);
	if (result.ok) return;
	// The secret and allowlist contents must not appear in the reason.
	expect(result.reason).not.toContain("ultra-secret");
	expect(result.reason).not.toContain("other-actor");
});
