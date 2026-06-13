/**
 * Settings registry tests (UNIT 5.2, hermetic).
 *
 * All side-effects faked: in-memory SQLite (runMigrations), in-memory EventLog,
 * and fail-closed validation. No network, no real config files. Each test owns
 * its own DB so the writer queue can't leak rows across cases.
 *
 * Matrix:
 *   1. REGISTRY structure: keys, types, scopes, defaults, and secret entries.
 *   2. getSetting / listSettings: read + mask secret values.
 *   3. putSetting: fail-closed (unknown_key, wrong_scope, scope_id_required,
 *      invalid_value) — including routine scope; happy path with audit event;
 *      secret never in payload (BLUEPRINT §3.12.7).
 *   4. deleteSetting: revert to default, not_found, audit event.
 *   5. listAuditEvents: newest first, limit.
 *   6. resolveEffectiveConfig: DB layers override base config with provenance;
 *      fail-closed for unknown keys and invalid values.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { events, settings } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import {
	REGISTRY,
	getSetting,
	listSettings,
	putSetting,
	deleteSetting,
	resolveEffectiveConfig,
	listAuditEvents,
	type SettingView,
} from "./registry.ts";
import { DEFAULT_CONFIG } from "./config.ts";

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

// ---------------------------------------------------------------------------
// 1. REGISTRY structure and defaults
// ---------------------------------------------------------------------------

test("REGISTRY has expected keys with correct types, scopes, and defaults", () => {
	// Check a few representative entries — use non-null assertion + toBeDefined guard.
	const concurrencyMax = REGISTRY["concurrency.maxParallelSlots"];
	expect(concurrencyMax).toBeDefined();
	if (!concurrencyMax) throw new Error("missing registry entry");
	expect(concurrencyMax.key).toBe("concurrency.maxParallelSlots");
	expect(concurrencyMax.configPath).toBe("concurrency.maxParallelSlots");
	expect(concurrencyMax.type).toBe("number");
	expect(concurrencyMax.scopes).toEqual(["global"]);
	expect(concurrencyMax.secret).toBe(false);
	expect(concurrencyMax.defaultValue).toBe(DEFAULT_CONFIG.concurrency.maxParallelSlots);

	const budgetWallClock = REGISTRY["budgets.wallClockSecondsPerRun"];
	expect(budgetWallClock).toBeDefined();
	if (!budgetWallClock) throw new Error("missing registry entry");
	expect(budgetWallClock.type).toBe("number");
	expect(budgetWallClock.scopes).toContain("global");
	expect(budgetWallClock.scopes).toContain("project");
	expect(budgetWallClock.scopes).toContain("routine");

	const autoMerge = REGISTRY["review.autoMergeEnabled"];
	expect(autoMerge).toBeDefined();
	if (!autoMerge) throw new Error("missing registry entry");
	expect(autoMerge.type).toBe("boolean");

	const loggingLevel = REGISTRY["logging.level"];
	expect(loggingLevel).toBeDefined();
	if (!loggingLevel) throw new Error("missing registry entry");
	expect(loggingLevel.type).toBe("string");

	// Secret entry (masking path).
	const telegramToken = REGISTRY["notify.telegramBotTokenRef"];
	expect(telegramToken).toBeDefined();
	if (!telegramToken) throw new Error("missing registry entry");
	expect(telegramToken.secret).toBe(true);
});

test("REGISTRY validators reject invalid values", () => {
	const concurrencyMax = REGISTRY["concurrency.maxParallelSlots"];
	if (!concurrencyMax) throw new Error("missing registry entry");
	expect(concurrencyMax.validate(0).ok).toBe(false); // must be positive
	expect(concurrencyMax.validate(-5).ok).toBe(false);
	expect(concurrencyMax.validate(1.5).ok).toBe(false); // must be integer
	expect(concurrencyMax.validate("10").ok).toBe(false); // must be number
	expect(concurrencyMax.validate(10).ok).toBe(true);

	const autoMerge = REGISTRY["review.autoMergeEnabled"];
	if (!autoMerge) throw new Error("missing registry entry");
	expect(autoMerge.validate(true).ok).toBe(true);
	expect(autoMerge.validate(false).ok).toBe(true);
	expect(autoMerge.validate("true").ok).toBe(false);

	const loggingLevel = REGISTRY["logging.level"];
	if (!loggingLevel) throw new Error("missing registry entry");
	expect(loggingLevel.validate("info").ok).toBe(true);
	expect(loggingLevel.validate("invalid").ok).toBe(false);
	const validation = loggingLevel.validate("invalid");
	expect(validation.ok).toBe(false);
	if (!validation.ok) {
		expect(validation.reason).toContain("must be one of");
	}
});

// ---------------------------------------------------------------------------
// 2. getSetting and listSettings with secret masking
// ---------------------------------------------------------------------------

test("getSetting retrieves a global setting by scope+key", async () => {
	// Insert directly into settings table.
	handle.db
		.insert(settings)
		.values({
			scope: "global",
			scopeId: null,
			key: "concurrency.maxParallelSlots",
			valueJson: "42",
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	const row = getSetting(handle, "global", null, "concurrency.maxParallelSlots");
	expect(row).toBeDefined();
	expect(row?.valueJson).toBe("42");
	expect(row?.key).toBe("concurrency.maxParallelSlots");
});

test("getSetting returns null for missing rows", () => {
	const row = getSetting(handle, "global", null, "nonexistent");
	expect(row).toBeNull();

	const projectRow = getSetting(handle, "project", 123, "budgets.wallClockSecondsPerRun");
	expect(projectRow).toBeNull();
});

test("getSetting distinguishes global (scope_id IS NULL) from scoped rows", async () => {
	// Insert a global and a project-scoped row with the same key.
	handle.db
		.insert(settings)
		.values({
			scope: "global",
			scopeId: null,
			key: "budgets.wallClockSecondsPerRun",
			valueJson: "100",
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	handle.db
		.insert(settings)
		.values({
			scope: "project",
			scopeId: 5,
			key: "budgets.wallClockSecondsPerRun",
			valueJson: "200",
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	// Fetch global.
	const globalRow = getSetting(handle, "global", null, "budgets.wallClockSecondsPerRun");
	expect(globalRow?.valueJson).toBe("100");

	// Fetch project-scoped.
	const projectRow = getSetting(handle, "project", 5, "budgets.wallClockSecondsPerRun");
	expect(projectRow?.valueJson).toBe("200");
});

test("listSettings returns all rows with secret values masked", async () => {
	// Insert a public and a secret setting.
	handle.db
		.insert(settings)
		.values({
			scope: "global",
			scopeId: null,
			key: "concurrency.maxParallelSlots",
			valueJson: "42",
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	handle.db
		.insert(settings)
		.values({
			scope: "global",
			scopeId: null,
			key: "notify.telegramBotTokenRef",
			valueJson: '"secret-token-12345"',
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	const rows = listSettings(handle);
	expect(rows.length).toBe(2);

	const publicRow = rows.find((r) => r.key === "concurrency.maxParallelSlots");
	expect(publicRow?.valueMasked).toBe(false);
	expect(publicRow?.valueJson).toBe("42");

	const secretRow = rows.find((r) => r.key === "notify.telegramBotTokenRef");
	expect(secretRow?.valueMasked).toBe(true);
	expect(secretRow?.valueJson).toBe('"********"'); // masked
});

test("listSettings filters by scope and scopeId", async () => {
	// Insert settings at different scopes.
	handle.db
		.insert(settings)
		.values({
			scope: "global",
			scopeId: null,
			key: "concurrency.maxParallelSlots",
			valueJson: "42",
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	handle.db
		.insert(settings)
		.values({
			scope: "project",
			scopeId: 1,
			key: "budgets.wallClockSecondsPerRun",
			valueJson: "300",
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	handle.db
		.insert(settings)
		.values({
			scope: "project",
			scopeId: 2,
			key: "budgets.wallClockSecondsPerRun",
			valueJson: "400",
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	// Filter by global scope.
	const globalOnly = listSettings(handle, { scope: "global" });
	expect(globalOnly.length).toBe(1);
	expect(globalOnly[0]?.scope).toBe("global");

	// Filter by project scope, project 1.
	const project1Only = listSettings(handle, { scope: "project", scopeId: 1 });
	expect(project1Only.length).toBe(1);
	expect(project1Only[0]?.scopeId).toBe(1);

	// Filter by project scope, project 2.
	const project2Only = listSettings(handle, { scope: "project", scopeId: 2 });
	expect(project2Only.length).toBe(1);
	expect(project2Only[0]?.scopeId).toBe(2);
});

// ---------------------------------------------------------------------------
// 3. putSetting: fail-closed cases and happy path
// ---------------------------------------------------------------------------

test("putSetting fails with unknown_key — no row written", async () => {
	const result = await putSetting(handle, log, {
		scope: "global",
		scopeId: null,
		key: "unknown.setting",
		value: 123,
		updatedBy: "test",
	});

	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe("unknown_key");
		expect(result.message).toContain("unknown settings key");
	}

	// No row inserted.
	const rows = handle.db.select().from(settings).all();
	expect(rows.length).toBe(0);
	// No audit event emitted.
	const evts = handle.db.select().from(events).all();
	expect(evts.length).toBe(0);
});

test("putSetting fails with wrong_scope — no row written", async () => {
	const result = await putSetting(handle, log, {
		scope: "project", // only global allowed
		scopeId: 1,
		key: "concurrency.maxParallelSlots",
		value: 42,
		updatedBy: "test",
	});

	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe("wrong_scope");
		expect(result.message).toContain("cannot be set at scope");
	}

	const rows = handle.db.select().from(settings).all();
	expect(rows.length).toBe(0);
	const evts = handle.db.select().from(events).all();
	expect(evts.length).toBe(0);
});

test("putSetting fails with scope_id_required for project scope — no row written", async () => {
	const result = await putSetting(handle, log, {
		scope: "project",
		scopeId: null, // project scope requires a scopeId
		key: "budgets.wallClockSecondsPerRun",
		value: 300,
		updatedBy: "test",
	});

	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe("scope_id_required");
		expect(result.message).toContain("requires a non-null scope_id");
	}

	const rows = handle.db.select().from(settings).all();
	expect(rows.length).toBe(0);
	const evts = handle.db.select().from(events).all();
	expect(evts.length).toBe(0);
});

test("putSetting fails with scope_id_required for routine scope — no row written", async () => {
	// routine scope also requires a scopeId — same fail-closed path.
	const result = await putSetting(handle, log, {
		scope: "routine",
		scopeId: null,
		key: "budgets.wallClockSecondsPerRun",
		value: 300,
		updatedBy: "test",
	});

	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe("scope_id_required");
	}

	const rows = handle.db.select().from(settings).all();
	expect(rows.length).toBe(0);
	const evts = handle.db.select().from(events).all();
	expect(evts.length).toBe(0);
});

test("putSetting fails with invalid_value — no row written", async () => {
	const result = await putSetting(handle, log, {
		scope: "global",
		scopeId: null,
		key: "concurrency.maxParallelSlots",
		value: -5, // must be positive
		updatedBy: "test",
	});

	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe("invalid_value");
		expect(result.message).toContain("invalid value");
	}

	const rows = handle.db.select().from(settings).all();
	expect(rows.length).toBe(0);
	const evts = handle.db.select().from(events).all();
	expect(evts.length).toBe(0);
});

test("putSetting succeeds and upserts a global setting with audit event", async () => {
	const result = await putSetting(handle, log, {
		scope: "global",
		scopeId: null,
		key: "concurrency.maxParallelSlots",
		value: 42,
		updatedBy: "test-user",
	});

	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("expected ok");
	expect(result.row.valueJson).toBe("42");
	expect(result.row.scope).toBe("global");
	expect(result.row.key).toBe("concurrency.maxParallelSlots");
	expect(result.row.valueMasked).toBe(false);

	// Row inserted.
	const rows = handle.db.select().from(settings).all();
	expect(rows.length).toBe(1);
	expect(rows[0]?.valueJson).toBe("42");

	// Audit event emitted.
	const auditEvents = handle.db
		.select()
		.from(events)
		.where(eq(events.kind, "settings.updated"))
		.all();
	expect(auditEvents.length).toBe(1);
	const payload = JSON.parse(auditEvents[0]!.payloadJson);
	expect(payload.scope).toBe("global");
	expect(payload.key).toBe("concurrency.maxParallelSlots");
	expect(payload.updatedBy).toBe("test-user");
	expect(payload.hadPrevious).toBe(false);
	expect(payload.newValue).toBe(42); // non-secret value included
});

test("putSetting upserting a project-scoped setting requires and uses scopeId", async () => {
	const result = await putSetting(handle, log, {
		scope: "project",
		scopeId: 5,
		key: "budgets.wallClockSecondsPerRun",
		value: 300,
		updatedBy: "test-user",
	});

	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("expected ok");
	expect(result.row.scopeId).toBe(5);
	expect(result.row.scope).toBe("project");

	const rows = handle.db.select().from(settings).all();
	expect(rows.length).toBe(1);
	expect(rows[0]?.scopeId).toBe(5);
});

test("putSetting updates existing row (upsert behavior, hadPrevious=true)", async () => {
	// Insert initial row.
	await putSetting(handle, log, {
		scope: "global",
		scopeId: null,
		key: "concurrency.maxParallelSlots",
		value: 42,
		updatedBy: "user1",
	});

	// Clear events to check the audit event for the update.
	handle.db.delete(events).run();

	// Update the row.
	const result = await putSetting(handle, log, {
		scope: "global",
		scopeId: null,
		key: "concurrency.maxParallelSlots",
		value: 100,
		updatedBy: "user2",
	});

	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("expected ok");
	expect(result.row.valueJson).toBe("100");

	// Only one row (upserted).
	const rows = handle.db.select().from(settings).all();
	expect(rows.length).toBe(1);
	expect(rows[0]?.valueJson).toBe("100");

	// Audit event indicates an update (hadPrevious=true).
	const auditEvents = handle.db
		.select()
		.from(events)
		.where(eq(events.kind, "settings.updated"))
		.all();
	expect(auditEvents.length).toBe(1);
	const payload = JSON.parse(auditEvents[0]!.payloadJson);
	expect(payload.hadPrevious).toBe(true);
});

test("putSetting masks secret values in audit payload — BLUEPRINT §3.12.7", async () => {
	const result = await putSetting(handle, log, {
		scope: "global",
		scopeId: null,
		key: "notify.telegramBotTokenRef",
		value: "secret-token-xyz",
		updatedBy: "test-user",
	});

	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("expected ok");
	// View should be masked.
	expect(result.row.valueMasked).toBe(true);
	expect(result.row.valueJson).toBe('"********"');

	// Audit event must NOT include the secret value — BLUEPRINT §3.12.7.
	const auditEvents = handle.db
		.select()
		.from(events)
		.where(eq(events.kind, "settings.updated"))
		.all();
	expect(auditEvents.length).toBe(1);
	const payload = JSON.parse(auditEvents[0]!.payloadJson);
	expect(payload).not.toHaveProperty("newValue");
	// Also verify the raw secret string is not anywhere in the serialised payload.
	expect(auditEvents[0]!.payloadJson).not.toContain("secret-token-xyz");
});

// ---------------------------------------------------------------------------
// 4. deleteSetting: revert to default and audit
// ---------------------------------------------------------------------------

test("deleteSetting fails with not_found for nonexistent rows", async () => {
	const result = await deleteSetting(handle, log, {
		scope: "global",
		scopeId: null,
		key: "concurrency.maxParallelSlots",
		updatedBy: "test-user",
	});

	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe("not_found");
		expect(result.message).toContain("no settings row found");
	}

	// No events emitted for a not_found delete.
	const evts = handle.db.select().from(events).all();
	expect(evts.length).toBe(0);
});

test("deleteSetting removes a row and emits audit event", async () => {
	// Insert a setting.
	await putSetting(handle, log, {
		scope: "global",
		scopeId: null,
		key: "concurrency.maxParallelSlots",
		value: 42,
		updatedBy: "user1",
	});

	// Clear events to check the delete audit event.
	handle.db.delete(events).run();

	// Delete it.
	const result = await deleteSetting(handle, log, {
		scope: "global",
		scopeId: null,
		key: "concurrency.maxParallelSlots",
		updatedBy: "user2",
	});

	expect(result.ok).toBe(true);

	// Row deleted.
	const rows = handle.db.select().from(settings).all();
	expect(rows.length).toBe(0);

	// Audit event emitted.
	const auditEvents = handle.db
		.select()
		.from(events)
		.where(eq(events.kind, "settings.reverted"))
		.all();
	expect(auditEvents.length).toBe(1);
	const payload = JSON.parse(auditEvents[0]!.payloadJson);
	expect(payload.scope).toBe("global");
	expect(payload.key).toBe("concurrency.maxParallelSlots");
	expect(payload.updatedBy).toBe("user2");
	// Revert payload must never contain the old value.
	expect(payload).not.toHaveProperty("oldValue");
	expect(payload).not.toHaveProperty("newValue");
});

test("deleteSetting distinguishes scopes and scopeIds", async () => {
	// Insert settings at different scopes.
	await putSetting(handle, log, {
		scope: "project",
		scopeId: 1,
		key: "budgets.wallClockSecondsPerRun",
		value: 300,
		updatedBy: "test",
	});

	await putSetting(handle, log, {
		scope: "project",
		scopeId: 2,
		key: "budgets.wallClockSecondsPerRun",
		value: 400,
		updatedBy: "test",
	});

	// Delete only project 1.
	const result = await deleteSetting(handle, log, {
		scope: "project",
		scopeId: 1,
		key: "budgets.wallClockSecondsPerRun",
		updatedBy: "test",
	});

	expect(result.ok).toBe(true);

	// Project 2 still there.
	const rows = handle.db.select().from(settings).all();
	expect(rows.length).toBe(1);
	expect(rows[0]?.scopeId).toBe(2);

	// Attempting to delete project 1 again returns not_found.
	const again = await deleteSetting(handle, log, {
		scope: "project",
		scopeId: 1,
		key: "budgets.wallClockSecondsPerRun",
		updatedBy: "test",
	});
	expect(again.ok).toBe(false);
	if (!again.ok) expect(again.reason).toBe("not_found");
});

// ---------------------------------------------------------------------------
// 5. listAuditEvents — newest first
// ---------------------------------------------------------------------------

test("listAuditEvents returns settings.updated and settings.reverted in order", async () => {
	// Emit several audit events.
	await putSetting(handle, log, {
		scope: "global",
		scopeId: null,
		key: "concurrency.maxParallelSlots",
		value: 42,
		updatedBy: "test",
	});

	await putSetting(handle, log, {
		scope: "global",
		scopeId: null,
		key: "review.autoMergeEnabled",
		value: true,
		updatedBy: "test",
	});

	await deleteSetting(handle, log, {
		scope: "global",
		scopeId: null,
		key: "concurrency.maxParallelSlots",
		updatedBy: "test",
	});

	const auditRows = listAuditEvents(handle);
	expect(auditRows.length).toBe(3);

	// Newest first (highest seq).
	expect(auditRows[0]?.kind).toBe("settings.reverted");
	expect(auditRows[1]?.kind).toBe("settings.updated");
	expect(auditRows[2]?.kind).toBe("settings.updated");
	expect((auditRows[0]?.seq ?? 0) > (auditRows[1]?.seq ?? 0)).toBe(true);
});

test("listAuditEvents respects the limit parameter", async () => {
	// Insert many settings.
	for (let i = 0; i < 10; i++) {
		await putSetting(handle, log, {
			scope: "global",
			scopeId: null,
			key: "concurrency.maxParallelSlots",
			value: 10 + i,
			updatedBy: "test",
		});
	}

	const all = listAuditEvents(handle);
	expect(all.length).toBe(10);

	const limited = listAuditEvents(handle, { limit: 3 });
	expect(limited.length).toBe(3);

	// Newest first.
	expect((limited[0]?.seq ?? 0) > (limited[1]?.seq ?? 0)).toBe(true);
});

// ---------------------------------------------------------------------------
// 6. resolveEffectiveConfig — layered overrides
// ---------------------------------------------------------------------------

test("resolveEffectiveConfig applies DB global layer to base config", () => {
	const base = structuredClone(DEFAULT_CONFIG);

	// Insert a global override.
	handle.db
		.insert(settings)
		.values({
			scope: "global",
			scopeId: null,
			key: "concurrency.maxParallelSlots",
			valueJson: "100",
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	const { config, provenance } = resolveEffectiveConfig(handle, base);
	expect(config.concurrency.maxParallelSlots).toBe(100);
	expect(provenance["concurrency.maxParallelSlots"]).toBe("db:global");
});

test("resolveEffectiveConfig layers: global < project < routine", () => {
	const base = structuredClone(DEFAULT_CONFIG);

	// Insert settings at each layer for the same key.
	handle.db
		.insert(settings)
		.values({
			scope: "global",
			scopeId: null,
			key: "budgets.wallClockSecondsPerRun",
			valueJson: "100",
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	handle.db
		.insert(settings)
		.values({
			scope: "project",
			scopeId: 5,
			key: "budgets.wallClockSecondsPerRun",
			valueJson: "200",
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	handle.db
		.insert(settings)
		.values({
			scope: "routine",
			scopeId: 7,
			key: "budgets.wallClockSecondsPerRun",
			valueJson: "300",
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	// Resolve with project 5 only — project wins over global.
	const { config: config1, provenance: prov1 } = resolveEffectiveConfig(handle, base, {
		projectId: 5,
	});
	expect(config1.budgets.wallClockSecondsPerRun).toBe(200);
	expect(prov1["budgets.wallClockSecondsPerRun"]).toBe("db:project");

	// Resolve with project 5 AND routine 7 — routine wins over project.
	const { config: config2, provenance: prov2 } = resolveEffectiveConfig(handle, base, {
		projectId: 5,
		routineId: 7,
	});
	expect(config2.budgets.wallClockSecondsPerRun).toBe(300);
	expect(prov2["budgets.wallClockSecondsPerRun"]).toBe("db:routine");
});

test("resolveEffectiveConfig skips unknown DB keys (fail-closed)", () => {
	const base = structuredClone(DEFAULT_CONFIG);

	// Insert an unknown key directly into the table.
	handle.db
		.insert(settings)
		.values({
			scope: "global",
			scopeId: null,
			key: "unknown.key",
			valueJson: "123",
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	// resolveEffectiveConfig should not throw; just ignore the unknown key.
	const { config } = resolveEffectiveConfig(handle, base);
	// Config is unchanged.
	expect(config).toEqual(base);
});

test("resolveEffectiveConfig composes baseProvenance with DB sources", () => {
	const base = structuredClone(DEFAULT_CONFIG);
	const baseProvenance = {
		"concurrency.maxParallelSlots": "file" as const,
		"review.autoMergeEnabled": "env" as const,
	};

	// Insert a DB global override for concurrency.maxParallelSlots.
	handle.db
		.insert(settings)
		.values({
			scope: "global",
			scopeId: null,
			key: "concurrency.maxParallelSlots",
			valueJson: "100",
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	const { provenance } = resolveEffectiveConfig(handle, base, {
		baseProvenance,
	});

	// DB global wins over file source.
	expect(provenance["concurrency.maxParallelSlots"]).toBe("db:global");
	// Env source stands (no override).
	expect(provenance["review.autoMergeEnabled"]).toBe("env");
});

test("resolveEffectiveConfig skips malformed/invalid values in DB (fail-closed)", () => {
	const base = structuredClone(DEFAULT_CONFIG);
	const originalMax = base.concurrency.maxParallelSlots;

	// Insert an invalid value (negative number for a positive-int key).
	handle.db
		.insert(settings)
		.values({
			scope: "global",
			scopeId: null,
			key: "concurrency.maxParallelSlots",
			valueJson: "-5", // invalid: must be positive
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	const { config } = resolveEffectiveConfig(handle, base);
	// Config unchanged; invalid value skipped.
	expect(config.concurrency.maxParallelSlots).toBe(originalMax);
});

test("resolveEffectiveConfig does not apply routine layer without routineId (fail-closed)", () => {
	const base = structuredClone(DEFAULT_CONFIG);
	const originalVal = base.budgets.wallClockSecondsPerRun;

	// Insert a routine-scoped override.
	handle.db
		.insert(settings)
		.values({
			scope: "routine",
			scopeId: 7,
			key: "budgets.wallClockSecondsPerRun",
			valueJson: "9999",
			updatedBy: "test",
			updatedAt: new Date().toISOString(),
		})
		.run();

	// No routineId supplied — routine layer must NOT be applied.
	const { config } = resolveEffectiveConfig(handle, base);
	expect(config.budgets.wallClockSecondsPerRun).toBe(originalVal);
});
