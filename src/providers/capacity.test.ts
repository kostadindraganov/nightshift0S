/**
 * Capacity-pool tests (PHASE5A-CONTRACT §3, ≤5 hermetic cases).
 *
 * All side-effects faked: in-memory SQLite (runMigrations), an injected clock,
 * and the real EventLog (in-memory broker). No network, no agent spawn. Each
 * test owns its own DB so the module-level writer queue can't leak rows across
 * cases.
 *
 * Matrix (per contract "Tests (≤5)"):
 *   1. unknown provider refuses; disabled refuses.
 *   2. 429 sets cooldown + opens circuit; canSpawn=cooldown blocks subscription
 *      until expiry, then (closed-circuit path) recovers.
 *   3. open circuit blocks during cooldown; expiry flips open→half_open
 *      single-probe; ok closes it.
 *   4. closed-circuit cooldown blocks subscription, but overflows to api_key
 *      ONLY when the knob is on (overflow keyed on requestedLane=subscription).
 *   5. at_cap counts non-terminal runs at the effective cap.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { events, providers, runs } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import {
	canSpawn,
	ensureProvider,
	observe,
	signalFromExitReason,
	type CapacityDeps,
} from "./capacity.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let handle: DbHandle;
let log: EventLog;
let clock: Date;

/** Build deps with the current (mutable) fake clock and given knobs. */
function makeDeps(overflowToApiKey = false, cooldownSeconds = 300): CapacityDeps {
	return { handle, log, now: () => clock, cooldownSeconds, overflowToApiKey };
}

/** Insert a non-terminal run for `provider` (counts toward the cap). */
function insertActiveRun(provider: string): void {
	handle.db
		.insert(runs)
		.values({ kind: "coder", provider, model: "m", authLane: "subscription", state: "running" })
		.run();
}

function providerRow(name: string) {
	return handle.db.select().from(providers).where(eq(providers.name, name)).get();
}

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
	clock = new Date("2026-06-13T00:00:00.000Z");
});

afterEach(() => {
	handle.sqlite.close();
});

// ---------------------------------------------------------------------------
// 1. Unknown / disabled providers refuse (fail-closed, never default-allow)
// ---------------------------------------------------------------------------

test("canSpawn refuses unknown and disabled providers", async () => {
	const deps = makeDeps();

	// No row → unknown_provider.
	expect(await canSpawn(deps, "ghost", "subscription")).toEqual({
		ok: false,
		reason: "unknown_provider",
	});

	// Seeded but disabled → disabled.
	await ensureProvider(deps, {
		name: "claude",
		kind: "cli",
		authMode: "subscription",
		concurrencyCap: 2,
	});
	handle.db.update(providers).set({ enabled: false }).where(eq(providers.name, "claude")).run();
	expect(await canSpawn(deps, "claude", "subscription")).toEqual({
		ok: false,
		reason: "disabled",
	});

	// signalFromExitReason: failure-side classifier never returns "ok".
	expect(signalFromExitReason("HTTP 429 rate limit")).toBe("429");
	expect(signalFromExitReason("usage limit reached")).toBe("auth_limit");
	expect(signalFromExitReason("segfault")).toBe("error");
	expect(signalFromExitReason(null)).toBe("error");
});

// ---------------------------------------------------------------------------
// 2. 429 sets cooldown + opens circuit; blocks until expiry
// ---------------------------------------------------------------------------

test("429 sets cooldown and opens circuit; canSpawn blocks until expiry", async () => {
	const deps = makeDeps(false, 300);
	await ensureProvider(deps, {
		name: "claude",
		kind: "cli",
		authMode: "subscription",
		concurrencyCap: 1,
	});

	await observe(deps, { provider: "claude", kind: "429", detail: "429 too many requests" });

	const row = providerRow("claude");
	expect(row?.circuitState).toBe("open");
	expect(row?.lastError).toBe("429 too many requests");
	expect(row?.cooldownUntil).toBe("2026-06-13T00:05:00.000Z"); // now + 300s

	// Open circuit + cooldown in the future → circuit_open.
	expect(await canSpawn(deps, "claude", "subscription")).toEqual({
		ok: false,
		reason: "circuit_open",
	});

	// Still cooling 1s before expiry.
	clock = new Date("2026-06-13T00:04:59.000Z");
	expect((await canSpawn(deps, "claude", "subscription")).ok).toBe(false);

	// A state-changed event was emitted for the 429.
	const evs = handle.db.select().from(events).all();
	expect(evs.some((e) => e.kind === "capacity.state_changed")).toBe(true);
});

// ---------------------------------------------------------------------------
// 3. Open circuit → expiry flips open→half_open single-probe → ok closes
// ---------------------------------------------------------------------------

test("expired open circuit flips to half_open single-probe, ok closes it", async () => {
	const deps = makeDeps(false, 300);
	await ensureProvider(deps, {
		name: "claude",
		kind: "cli",
		authMode: "subscription",
		concurrencyCap: 5, // generous row cap — probe must clamp to 1.
	});
	await observe(deps, { provider: "claude", kind: "429" });

	// Advance past cooldown expiry.
	clock = new Date("2026-06-13T00:05:01.000Z");

	// First canSpawn after expiry: flips open→half_open and allows one probe.
	expect(await canSpawn(deps, "claude", "subscription")).toEqual({
		ok: true,
		lane: "subscription",
	});
	expect(providerRow("claude")?.circuitState).toBe("half_open");

	// half_open effective cap is 1 (NOT the row's 5): one active run → at_cap.
	insertActiveRun("claude");
	expect(await canSpawn(deps, "claude", "subscription")).toEqual({
		ok: false,
		reason: "at_cap",
	});

	// ok signal closes the probe and clears cooldown/error.
	await observe(deps, { provider: "claude", kind: "ok" });
	const row = providerRow("claude");
	expect(row?.circuitState).toBe("closed");
	expect(row?.cooldownUntil).toBeNull();
	expect(row?.lastError).toBeNull();
});

// ---------------------------------------------------------------------------
// 4. Cooldown overflow: subscription→api_key only when the knob is on
// ---------------------------------------------------------------------------

test("closed-circuit cooldown blocks subscription, overflows to api_key only when enabled", async () => {
	// Put the provider in a CLOSED circuit with an active cooldown directly, so
	// we exercise step 4 (cooldown) rather than step 3 (circuit). 429 opens the
	// circuit, so we set cooldown_until by hand on a closed circuit.
	const off = makeDeps(false, 300);
	await ensureProvider(off, {
		name: "claude",
		kind: "cli",
		authMode: "subscription",
		concurrencyCap: 1,
	});
	handle.db
		.update(providers)
		.set({ circuitState: "closed", cooldownUntil: "2026-06-13T00:05:00.000Z" })
		.where(eq(providers.name, "claude"))
		.run();

	// Knob OFF → subscription blocked, no silent paid overflow.
	expect(await canSpawn(off, "claude", "subscription")).toEqual({
		ok: false,
		reason: "cooldown",
	});

	// Knob ON → subscription overflows to the metered api_key lane.
	const on = makeDeps(true, 300);
	expect(await canSpawn(on, "claude", "subscription")).toEqual({
		ok: true,
		lane: "api_key",
	});

	// Per contract §3.2 step 4 the overflow is keyed on requestedLane ===
	// "subscription"; a direct api_key request during a closed-circuit cooldown
	// still falls into the `else` → cooldown (the overflow is the only escape).
	expect(await canSpawn(on, "claude", "api_key")).toEqual({ ok: false, reason: "cooldown" });
});

// ---------------------------------------------------------------------------
// 5. at_cap counts non-terminal runs against the row's concurrency_cap
// ---------------------------------------------------------------------------

test("at_cap counts only non-terminal runs against concurrency_cap", async () => {
	const deps = makeDeps();
	await ensureProvider(deps, {
		name: "claude",
		kind: "cli",
		authMode: "subscription",
		concurrencyCap: 2,
	});

	// Terminal runs do NOT count.
	handle.db
		.insert(runs)
		.values({ kind: "coder", provider: "claude", model: "m", authLane: "subscription", state: "succeeded" })
		.run();
	expect((await canSpawn(deps, "claude", "subscription")).ok).toBe(true);

	// Two active runs reach the cap of 2.
	insertActiveRun("claude");
	insertActiveRun("claude");
	expect(await canSpawn(deps, "claude", "subscription")).toEqual({
		ok: false,
		reason: "at_cap",
	});

	// A run for a DIFFERENT provider doesn't count against this one.
	await ensureProvider(deps, {
		name: "codex",
		kind: "cli",
		authMode: "api_key",
		concurrencyCap: 1,
	});
	expect((await canSpawn(deps, "codex", "api_key")).ok).toBe(true);
});
