/**
 * WHY: Capacity pools (BLUEPRINT §3.12.14) are the fail-closed scheduler gate
 * that keeps the factory inside a provider's *opaque* limits. There is no real
 * quota API for subscription CLIs, so a pool's health is inferred only from
 * observed 429/auth-limit signals plus operator-configured caps/cooldowns,
 * persisted on the providers row. This module is the SOLE writer of
 * `providers.cooldown_until / circuit_state / last_error` and the reader of
 * record for `concurrency_cap` (PHASE5A-CONTRACT §2).
 *
 * Two surfaces:
 *   canSpawn — consulted BEFORE every claim. Returns a REFUSE decision during
 *     cooldown / open circuit / at-cap, never default-allows an unknown
 *     provider. The only "allow" mutation is the open→half_open probe flip.
 *   observe — the signal sink. 429/auth_limit set a cooldown and trip the
 *     circuit; a generic error records last_error only (it must NOT trip the
 *     circuit — auto-triage owns generic-failure policy); ok closes a
 *     half_open probe.
 *
 * Fail-closed everywhere: a missing provider, a future cooldown, an open
 * circuit, or a full cap all REFUSE rather than over-spawn. All side-effects
 * (clock, DB, event log) are injected via CapacityDeps so this runs on macOS
 * with fakes — no network, no live agent. Every row write rides the single
 * serialized writer queue (`enqueueWrite`); the state-change event is emitted
 * in the SAME link via `emitInWriter` so durability and publish order match.
 */

import { and, eq, notInArray } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import type { AuthLane, ProviderAuthMode, ProviderKind } from "../db/columns.ts";
import { RUN_TERMINAL_STATES, type RunState } from "../db/columns.ts";
import { providers, runs, type ProviderRow } from "../db/schema.ts";
import { enqueueWrite } from "../db/writer.ts";
import type { EventLog } from "../events/events.ts";

// ---------------------------------------------------------------------------
// Public types (PHASE5A-CONTRACT §3.1 — pinned)
// ---------------------------------------------------------------------------

export type CapacitySignalKind = "429" | "auth_limit" | "ok" | "error";

export interface CapacitySignal {
	/** providers.name */
	provider: string;
	kind: CapacitySignalKind;
	/** free text → providers.last_error on failure kinds */
	detail?: string;
}

export type CapacityDecision =
	| { ok: true; lane: AuthLane }
	| {
			ok: false;
			reason: "unknown_provider" | "disabled" | "circuit_open" | "cooldown" | "at_cap";
	  };

export interface CapacityDeps {
	handle: DbHandle;
	log: EventLog;
	/** injectable clock */
	now(): Date;
	/** config capacity.cooldownSeconds */
	cooldownSeconds: number;
	/** config capacity.overflowToApiKey (default false) */
	overflowToApiKey: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Read a provider row by name (synchronous; reads are unrestricted under WAL). */
function getProvider(handle: DbHandle, name: string): ProviderRow | null {
	return handle.db.select().from(providers).where(eq(providers.name, name)).get() ?? null;
}

/**
 * Is `cooldownUntil` in the future relative to `now`? A null/empty/unparseable
 * value is treated as NOT cooling down (no active cooldown). An unparseable
 * timestamp is the only ambiguous case; cooldown is an *additional* refuse on
 * top of the circuit/cap gates, so treating a corrupt value as "expired" cannot
 * over-spawn past the cap — it just declines an extra block.
 */
function cooldownActive(cooldownUntil: string | null, now: Date): boolean {
	if (cooldownUntil === null || cooldownUntil === "") return false;
	const until = Date.parse(cooldownUntil);
	if (Number.isNaN(until)) return false;
	return until > now.getTime();
}

/** Count runs for `provider` whose state is NOT terminal (the live concurrency). */
function activeRunCount(handle: DbHandle, provider: string): number {
	return handle.db
		.select()
		.from(runs)
		.where(
			and(
				eq(runs.provider, provider),
				notInArray(runs.state, [...RUN_TERMINAL_STATES] as RunState[]),
			),
		)
		.all().length;
}

/**
 * Emit the `capacity.state_changed` event. Called from INSIDE a writer-queue
 * link (so it uses `emitInWriter`, not `emitEvent`, which would deadlock the
 * chain — see events.ts).
 */
function emitStateChanged(
	log: EventLog,
	provider: ProviderRow,
	signal: CapacitySignalKind,
): void {
	log.emitInWriter({
		kind: "capacity.state_changed",
		payload: {
			provider: provider.name,
			signal,
			circuitState: provider.circuitState,
			cooldownUntil: provider.cooldownUntil,
			lastError: provider.lastError,
		},
	});
}

// ---------------------------------------------------------------------------
// ensureProvider — boot-time seeding (INTEGRATION calls this)
// ---------------------------------------------------------------------------

/**
 * Upsert a provider by name. On insert, seed caps/auth and a closed circuit.
 * On an EXISTING row, update only the static descriptor (kind/authMode/cap) and
 * NEVER clobber capacity state (cooldown_until/circuit_state/last_error) or
 * capabilities_json (owned by conformance.ts). Re-seeding at every boot must
 * not wipe a cooldown set by a 429 in the last run.
 */
export async function ensureProvider(
	deps: CapacityDeps,
	input: {
		name: string;
		kind: ProviderKind;
		authMode: ProviderAuthMode;
		concurrencyCap: number;
	},
): Promise<void> {
	await enqueueWrite(() => {
		const existing = getProvider(deps.handle, input.name);
		if (existing === null) {
			deps.handle.db
				.insert(providers)
				.values({
					name: input.name,
					kind: input.kind,
					authMode: input.authMode,
					concurrencyCap: input.concurrencyCap,
					// enabled/circuitState default on the column; capacity state null.
				})
				.run();
			return;
		}
		// Existing row: refresh static descriptor only.
		deps.handle.db
			.update(providers)
			.set({
				kind: input.kind,
				authMode: input.authMode,
				concurrencyCap: input.concurrencyCap,
			})
			.where(eq(providers.name, input.name))
			.run();
	});
}

// ---------------------------------------------------------------------------
// canSpawn — THE scheduler gate (PHASE5A-CONTRACT §3.2)
// ---------------------------------------------------------------------------

/**
 * Evaluate, in order, fail-closed:
 *   1. no row → unknown_provider (refuse, never default-allow)
 *   2. enabled === false → disabled
 *   3. circuit open + cooldown in the future → circuit_open;
 *      open + cooldown expired → flip open→half_open (single-probe), cap 1;
 *      half_open → cap 1
 *   4. circuit closed + cooldown in the future →
 *        subscription + overflowToApiKey → {ok, lane:"api_key"} (the overflow);
 *        else → cooldown
 *   5. active (non-terminal) run count >= effectiveCap → at_cap
 *   6. otherwise → {ok, lane: requestedLane}
 */
export async function canSpawn(
	deps: CapacityDeps,
	provider: string,
	requestedLane: AuthLane,
): Promise<CapacityDecision> {
	const { handle } = deps;
	const now = deps.now();

	// 1. Unknown provider — refuse.
	const row = getProvider(handle, provider);
	if (row === null) return { ok: false, reason: "unknown_provider" };

	// 2. Disabled.
	if (row.enabled === false) return { ok: false, reason: "disabled" };

	// 3. Circuit.
	let effectiveCap = row.concurrencyCap;
	if (row.circuitState === "open") {
		if (cooldownActive(row.cooldownUntil, now)) {
			return { ok: false, reason: "circuit_open" };
		}
		// Cooldown expired on an open circuit → probe: flip open→half_open and
		// continue with an effective cap of 1 (a single probe run).
		await flipToHalfOpen(deps, provider);
		effectiveCap = 1;
	} else if (row.circuitState === "half_open") {
		effectiveCap = 1;
	} else {
		// 4. Circuit closed: cooldown gates the subscription lane.
		if (cooldownActive(row.cooldownUntil, now)) {
			if (requestedLane === "subscription" && deps.overflowToApiKey) {
				// §3.12.14 overflow: subscription quota is exhausted (the cooldown
				// models that); the api_key lane is metered money and stays open.
				return { ok: true, lane: "api_key" };
			}
			return { ok: false, reason: "cooldown" };
		}
	}

	// 5. Concurrency cap.
	if (activeRunCount(handle, provider) >= effectiveCap) {
		return { ok: false, reason: "at_cap" };
	}

	// 6. Allow on the requested lane.
	return { ok: true, lane: requestedLane };
}

/**
 * Flip an open circuit whose cooldown has expired to half_open and emit the
 * state-change event — both inside one writer-queue link. Re-reads the row
 * inside the link and only flips if it is still `open` (another tick may have
 * flipped or re-opened it), so the probe is granted exactly once.
 */
async function flipToHalfOpen(deps: CapacityDeps, provider: string): Promise<void> {
	await enqueueWrite(() => {
		const row = getProvider(deps.handle, provider);
		if (row === null || row.circuitState !== "open") return;
		const updated = deps.handle.db
			.update(providers)
			.set({ circuitState: "half_open" })
			.where(eq(providers.name, provider))
			.returning()
			.get();
		if (updated) emitStateChanged(deps.log, updated, "ok");
	});
}

// ---------------------------------------------------------------------------
// observe — signal sink (PHASE5A-CONTRACT §3.2)
// ---------------------------------------------------------------------------

/**
 * Apply a capacity signal to the provider row. All row writes + the
 * `capacity.state_changed` event happen inside ONE writer-queue link
 * (`emitInWriter` in the same link as the UPDATE). An unknown provider is a
 * no-op (nothing to mutate) — fail-closed: a signal for a phantom provider must
 * never create a row or silently allow.
 *
 *   429 / auth_limit → set cooldown_until = now + cooldownSeconds, last_error;
 *                      trip the circuit (half_open→open probe-failed, closed→open).
 *   error            → record last_error only (does NOT trip the circuit).
 *   ok               → half_open→closed, clear cooldown_until + last_error.
 *                      (closed stays closed; open+ok is a stale signal — ignore.)
 */
export async function observe(deps: CapacityDeps, signal: CapacitySignal): Promise<void> {
	const { handle, log } = deps;

	await enqueueWrite(() => {
		const row = getProvider(handle, signal.provider);
		if (row === null) return; // unknown provider — nothing to mutate.

		switch (signal.kind) {
			case "429":
			case "auth_limit": {
				const cooldownUntil = new Date(
					deps.now().getTime() + deps.cooldownSeconds * 1000,
				).toISOString();
				// half_open probe failed → back to open; otherwise (closed/open) → open.
				const circuitState = "open" as const;
				const updated = handle.db
					.update(providers)
					.set({
						cooldownUntil,
						lastError: signal.detail ?? signal.kind,
						circuitState,
					})
					.where(eq(providers.name, signal.provider))
					.returning()
					.get();
				if (updated) emitStateChanged(log, updated, signal.kind);
				return;
			}

			case "error": {
				// Generic failure: record last_error only — do NOT trip the circuit.
				const updated = handle.db
					.update(providers)
					.set({ lastError: signal.detail ?? signal.kind })
					.where(eq(providers.name, signal.provider))
					.returning()
					.get();
				if (updated) emitStateChanged(log, updated, signal.kind);
				return;
			}

			case "ok": {
				// Only a half_open probe success is state-affecting. A closed circuit
				// stays closed; an open circuit + ok is a stale signal — ignore both
				// (no write, no event) so we don't emit noise on every healthy run.
				if (row.circuitState !== "half_open") return;
				const updated = handle.db
					.update(providers)
					.set({ circuitState: "closed", cooldownUntil: null, lastError: null })
					.where(eq(providers.name, signal.provider))
					.returning()
					.get();
				if (updated) emitStateChanged(log, updated, signal.kind);
				return;
			}
		}
	});
}

// ---------------------------------------------------------------------------
// signalFromExitReason — pure failure-side classifier
// ---------------------------------------------------------------------------

/**
 * Map a `runs.exit_reason` (plus any transcript hints already folded into it)
 * to a capacity signal kind. FAILURE side only — never returns "ok"; an
 * unrecognized reason is "error" (record-only), which fail-closed-ly avoids
 * tripping the circuit on a failure we couldn't classify as quota/auth.
 */
export function signalFromExitReason(
	exitReason: string | null,
): Exclude<CapacitySignalKind, "ok"> {
	if (exitReason === null) return "error";
	const r = exitReason.toLowerCase();
	if (r.includes("429") || r.includes("rate_limit") || r.includes("rate limit")) {
		return "429";
	}
	if (
		r.includes("auth_limit") ||
		r.includes("auth limit") ||
		r.includes("quota") ||
		r.includes("usage limit") ||
		r.includes("usage_limit") ||
		r.includes("401") ||
		r.includes("403") ||
		// Credential-error synonyms (the canonical Claude/Codex auth-failure exit
		// reasons). Folded in so the SOLE classifier covers both subscription
		// exhaustion AND dead-credential failures — triage delegates here, so a
		// divergent copy can't drift and miss one set or the other.
		r.includes("authentication_error") ||
		r.includes("invalid_api_key") ||
		r.includes("unauthorized")
	) {
		return "auth_limit";
	}
	return "error";
}
