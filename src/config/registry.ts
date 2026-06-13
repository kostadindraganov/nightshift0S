/**
 * WHY: Editable scoped settings registry (BLUEPRINT §3.12.19).
 *
 * The `settings` table lets operators override NightshiftConfig knobs at
 * runtime — no process restart required — scoped to global / project / routine.
 * This module is the SOLE interface to that table for writes and is the
 * canonical source for which keys are editable (REGISTRY), what values are
 * valid, and how to compose an effective config from the DB layers on top of
 * a file+env-merged base.
 *
 * Three guarantees:
 *   1. Fail-closed writes: unknown_key / wrong_scope / scope_id_required /
 *      invalid_value are all synchronously refused before any DB touch.
 *   2. Secret values are NEVER returned or placed in event payloads; the view
 *      type masks them to "********" (BLUEPRINT §3.12.7).
 *   3. All row mutations ride `enqueueWrite`; the audit "settings.updated" /
 *      "settings.reverted" event is emitted in the SAME link via `emitInWriter`
 *      so durability and event order are guaranteed to match.
 *
 * Global-scope upsert: SQLite NULL-distinct semantics mean two global rows with
 * the same key are NOT caught by the UNIQUE(scope, scope_id, key) index because
 * `scope_id` is NULL for both. We therefore always upsert globals by
 * select-then-insert-or-update rather than relying on an ON CONFLICT clause.
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import type { SettingScope } from "../db/columns.ts";
import { settings, events, type SettingRow } from "../db/schema.ts";
import { enqueueWrite } from "../db/writer.ts";
import type { EventLog } from "../events/events.ts";
import { DEFAULT_CONFIG, type NightshiftConfig } from "./config.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SettingType = "number" | "boolean" | "string" | "stringArray";

export interface RegistryEntry {
	/** The settings table key. */
	key: string;
	/** Dotted path into NightshiftConfig this key overrides, e.g. "concurrency.maxParallelSlots". */
	configPath: string;
	type: SettingType;
	/** Which scopes may set this key. */
	scopes: SettingScope[];
	/** If true, the stored value is a reference (not the secret itself) and must be masked in outputs. */
	secret: boolean;
	/** Default value drawn from DEFAULT_CONFIG. */
	defaultValue: unknown;
	/** Validate a decoded (runtime-typed) value. */
	validate(value: unknown): { ok: true } | { ok: false; reason: string };
}

/** A SettingRow with secret values optionally masked. */
export interface SettingView extends SettingRow {
	valueMasked: boolean;
}

// ---------------------------------------------------------------------------
// Validators (reusable)
// ---------------------------------------------------------------------------

function isPositiveInt(v: unknown): boolean {
	return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isNonNegativeInt(v: unknown): boolean {
	return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isBoolean(v: unknown): boolean {
	return typeof v === "boolean";
}

function isStringArray(v: unknown): boolean {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isLogLevel(v: unknown): boolean {
	return typeof v === "string" && ["trace", "debug", "info", "warn", "error", "fatal"].includes(v);
}

// ---------------------------------------------------------------------------
// REGISTRY
// ---------------------------------------------------------------------------

/**
 * The canonical set of runtime-tunable knobs. Each entry maps a settings key
 * to its NightshiftConfig target, allowed scopes, type, and validator.
 *
 * Non-editable knobs (server, database, sandbox, forge, providers, timeouts)
 * are intentionally absent — they require a restart or are security-sensitive.
 *
 * One synthetic "secret" entry (notify.telegramBotTokenRef) exercises the
 * masking path so the secret=true branch is covered in tests even though no
 * real secret values are stored in the settings table.
 */
export const REGISTRY: Record<string, RegistryEntry> = {
	// -- concurrency -----------------------------------------------------------
	"concurrency.maxParallelSlots": {
		key: "concurrency.maxParallelSlots",
		configPath: "concurrency.maxParallelSlots",
		type: "number",
		scopes: ["global"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.concurrency.maxParallelSlots,
		validate(v) {
			if (!isPositiveInt(v)) return { ok: false, reason: "must be a positive integer" };
			return { ok: true };
		},
	},
	"concurrency.maxReviewWip": {
		key: "concurrency.maxReviewWip",
		configPath: "concurrency.maxReviewWip",
		type: "number",
		scopes: ["global"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.concurrency.maxReviewWip,
		validate(v) {
			if (!isPositiveInt(v)) return { ok: false, reason: "must be a positive integer" };
			return { ok: true };
		},
	},
	"concurrency.perProviderCap": {
		key: "concurrency.perProviderCap",
		configPath: "concurrency.perProviderCap",
		type: "number",
		scopes: ["global"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.concurrency.perProviderCap,
		validate(v) {
			if (!isPositiveInt(v)) return { ok: false, reason: "must be a positive integer" };
			return { ok: true };
		},
	},
	"concurrency.schedulerIntervalSeconds": {
		key: "concurrency.schedulerIntervalSeconds",
		configPath: "concurrency.schedulerIntervalSeconds",
		type: "number",
		scopes: ["global"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.concurrency.schedulerIntervalSeconds,
		validate(v) {
			if (!isPositiveInt(v)) return { ok: false, reason: "must be a positive integer" };
			return { ok: true };
		},
	},
	// -- capacity --------------------------------------------------------------
	"capacity.cooldownSeconds": {
		key: "capacity.cooldownSeconds",
		configPath: "capacity.cooldownSeconds",
		type: "number",
		scopes: ["global"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.capacity.cooldownSeconds,
		validate(v) {
			if (!isNonNegativeInt(v)) return { ok: false, reason: "must be a non-negative integer" };
			return { ok: true };
		},
	},
	"capacity.overflowToApiKey": {
		key: "capacity.overflowToApiKey",
		configPath: "capacity.overflowToApiKey",
		type: "boolean",
		scopes: ["global"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.capacity.overflowToApiKey,
		validate(v) {
			if (!isBoolean(v)) return { ok: false, reason: "must be a boolean" };
			return { ok: true };
		},
	},
	// -- budgets ---------------------------------------------------------------
	"budgets.wallClockSecondsPerRun": {
		key: "budgets.wallClockSecondsPerRun",
		configPath: "budgets.wallClockSecondsPerRun",
		type: "number",
		scopes: ["global", "project", "routine"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.budgets.wallClockSecondsPerRun,
		validate(v) {
			if (!isPositiveInt(v)) return { ok: false, reason: "must be a positive integer" };
			return { ok: true };
		},
	},
	"budgets.advisoryTokensPerRun": {
		key: "budgets.advisoryTokensPerRun",
		configPath: "budgets.advisoryTokensPerRun",
		type: "number",
		scopes: ["global", "project", "routine"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.budgets.advisoryTokensPerRun,
		validate(v) {
			if (!isNonNegativeInt(v)) return { ok: false, reason: "must be a non-negative integer" };
			return { ok: true };
		},
	},
	"budgets.hardCostUsdPerRun": {
		key: "budgets.hardCostUsdPerRun",
		configPath: "budgets.hardCostUsdPerRun",
		type: "number",
		scopes: ["global", "project", "routine"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.budgets.hardCostUsdPerRun,
		validate(v) {
			if (typeof v !== "number" || v < 0 || !isFinite(v)) {
				return { ok: false, reason: "must be a non-negative number" };
			}
			return { ok: true };
		},
	},
	// -- triage ----------------------------------------------------------------
	"triage.maxRetries": {
		key: "triage.maxRetries",
		configPath: "triage.maxRetries",
		type: "number",
		scopes: ["global", "project", "routine"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.triage.maxRetries,
		validate(v) {
			if (!isNonNegativeInt(v)) return { ok: false, reason: "must be a non-negative integer" };
			return { ok: true };
		},
	},
	// -- review ----------------------------------------------------------------
	"review.maxRounds": {
		key: "review.maxRounds",
		configPath: "review.maxRounds",
		type: "number",
		scopes: ["global", "project", "routine"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.review.maxRounds,
		validate(v) {
			if (!isPositiveInt(v)) return { ok: false, reason: "must be a positive integer" };
			return { ok: true };
		},
	},
	"review.autoMergeEnabled": {
		key: "review.autoMergeEnabled",
		configPath: "review.autoMergeEnabled",
		type: "boolean",
		scopes: ["global", "project", "routine"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.review.autoMergeEnabled,
		validate(v) {
			if (!isBoolean(v)) return { ok: false, reason: "must be a boolean" };
			return { ok: true };
		},
	},
	"review.specialistHarness": {
		key: "review.specialistHarness",
		configPath: "review.specialistHarness",
		type: "boolean",
		scopes: ["global", "project", "routine"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.review.specialistHarness,
		validate(v) {
			if (!isBoolean(v)) return { ok: false, reason: "must be a boolean" };
			return { ok: true };
		},
	},
	// -- coder -----------------------------------------------------------------
	"coder.skillsMount": {
		key: "coder.skillsMount",
		configPath: "coder.skillsMount",
		type: "stringArray",
		scopes: ["global", "project", "routine"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.coder.skillsMount,
		validate(v) {
			if (!isStringArray(v)) return { ok: false, reason: "must be an array of skill slugs" };
			return { ok: true };
		},
	},
	"coder.fileFollowUps": {
		key: "coder.fileFollowUps",
		configPath: "coder.fileFollowUps",
		type: "boolean",
		scopes: ["global", "project", "routine"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.coder.fileFollowUps,
		validate(v) {
			if (!isBoolean(v)) return { ok: false, reason: "must be a boolean" };
			return { ok: true };
		},
	},
	// -- logging ---------------------------------------------------------------
	"logging.level": {
		key: "logging.level",
		configPath: "logging.level",
		type: "string",
		scopes: ["global"],
		secret: false,
		defaultValue: DEFAULT_CONFIG.logging.level,
		validate(v) {
			if (!isLogLevel(v)) {
				return {
					ok: false,
					reason: "must be one of: trace, debug, info, warn, error, fatal",
				};
			}
			return { ok: true };
		},
	},
	// -- secret shape example (masking path exercised in tests) ----------------
	// BLUEPRINT §3.12.7: only references are stored, never raw secret values.
	"notify.telegramBotTokenRef": {
		key: "notify.telegramBotTokenRef",
		// No real NightshiftConfig path — this is a forward-compat placeholder.
		configPath: "notify.telegramBotTokenRef",
		type: "string",
		scopes: ["global"],
		secret: true,
		defaultValue: "",
		validate(v) {
			if (typeof v !== "string" || v.trim() === "") {
				return { ok: false, reason: "must be a non-empty string (token reference)" };
			}
			return { ok: true };
		},
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MASKED = "********";

/** Decode a value_json string from the DB into a runtime value. */
function decodeValue(valueJson: string): unknown {
	try {
		return JSON.parse(valueJson);
	} catch {
		return valueJson;
	}
}

/** Mask a SettingRow for secret keys. Returns a SettingView with the masked valueJson. */
function toView(row: SettingRow, def: RegistryEntry): SettingView {
	if (!def.secret) return { ...row, valueMasked: false };
	return { ...row, valueJson: JSON.stringify(MASKED), valueMasked: true };
}

// ---------------------------------------------------------------------------
// getSetting — single-row read
// ---------------------------------------------------------------------------

/**
 * Read a settings row. For global scope, matches WHERE scope_id IS NULL.
 * Returns null if absent (callers should fall back to DEFAULT_CONFIG).
 */
export function getSetting(
	handle: DbHandle,
	scope: SettingScope,
	scopeId: number | null,
	key: string,
): SettingRow | null {
	if (scope === "global") {
		return (
			handle.db
				.select()
				.from(settings)
				.where(
					and(
						eq(settings.scope, scope),
						isNull(settings.scopeId),
						eq(settings.key, key),
					),
				)
				.get() ?? null
		);
	}
	if (scopeId === null) return null;
	return (
		handle.db
			.select()
			.from(settings)
			.where(
				and(
					eq(settings.scope, scope),
					eq(settings.scopeId, scopeId),
					eq(settings.key, key),
				),
			)
			.get() ?? null
	);
}

// ---------------------------------------------------------------------------
// listSettings — filtered list with secret masking
// ---------------------------------------------------------------------------

/**
 * List settings rows, optionally filtered by scope/scopeId.
 * Secret values are masked to "********" in the returned SettingView objects.
 */
export function listSettings(
	handle: DbHandle,
	filter?: { scope?: SettingScope; scopeId?: number | null },
): SettingView[] {
	const conditions = [];
	if (filter?.scope !== undefined) {
		conditions.push(eq(settings.scope, filter.scope));
	}
	if (filter?.scopeId !== undefined) {
		if (filter.scopeId === null) {
			conditions.push(isNull(settings.scopeId));
		} else {
			conditions.push(eq(settings.scopeId, filter.scopeId));
		}
	}

	const rows =
		conditions.length > 0
			? handle.db
					.select()
					.from(settings)
					.where(and(...conditions))
					.all()
			: handle.db.select().from(settings).all();

	return rows.map((row) => {
		const def = REGISTRY[row.key];
		if (!def) return { ...row, valueMasked: false };
		return toView(row, def);
	});
}

// ---------------------------------------------------------------------------
// putSetting — validated upsert + audit event
// ---------------------------------------------------------------------------

export interface PutSettingInput {
	scope: SettingScope;
	scopeId: number | null;
	key: string;
	/** The decoded runtime value (not yet JSON-serialised). */
	value: unknown;
	updatedBy: string;
}

export type PutSettingResult =
	| { ok: true; row: SettingView }
	| {
			ok: false;
			reason:
				| "unknown_key"
				| "wrong_scope"
				| "scope_id_required"
				| "invalid_value";
			message: string;
	  };

/**
 * Validated upsert of a settings row. Fail-closed:
 *   - unknown_key if key is not in REGISTRY.
 *   - wrong_scope if the key's definition doesn't allow the requested scope.
 *   - scope_id_required if scope is project/routine but scopeId is null.
 *   - invalid_value if the key's validator rejects the value.
 *
 * On success, upserts inside enqueueWrite (upsert-by-select for global to
 * defeat SQLite NULL-distinct) and emits "settings.updated" in the same link.
 * New value is included in the event payload only for non-secret keys.
 */
export async function putSetting(
	handle: DbHandle,
	log: EventLog,
	input: PutSettingInput,
): Promise<PutSettingResult> {
	// 1. Key must be in the registry.
	const def = REGISTRY[input.key];
	if (!def) {
		return { ok: false, reason: "unknown_key", message: `unknown settings key: ${input.key}` };
	}

	// 2. Scope must be allowed for this key.
	if (!def.scopes.includes(input.scope)) {
		return {
			ok: false,
			reason: "wrong_scope",
			message: `key "${input.key}" cannot be set at scope "${input.scope}" (allowed: ${def.scopes.join(", ")})`,
		};
	}

	// 3. project/routine scopes require a scopeId.
	if ((input.scope === "project" || input.scope === "routine") && input.scopeId === null) {
		return {
			ok: false,
			reason: "scope_id_required",
			message: `scope "${input.scope}" requires a non-null scope_id`,
		};
	}

	// 4. Validate value.
	const validation = def.validate(input.value);
	if (!validation.ok) {
		return {
			ok: false,
			reason: "invalid_value",
			message: `invalid value for "${input.key}": ${validation.reason}`,
		};
	}

	const valueJson = JSON.stringify(input.value);
	const updatedAt = new Date().toISOString();

	// 5. Upsert inside the writer queue; emit audit event in the same link.
	const resultRow = await enqueueWrite((): SettingRow => {
		// Upsert-by-select: read the existing row, then insert or update.
		const existing = getSetting(handle, input.scope, input.scopeId, input.key);
		const hadPrevious = existing !== null;

		let row: SettingRow;
		if (existing === null) {
			// Insert new row.
			row = handle.db
				.insert(settings)
				.values({
					scope: input.scope,
					scopeId: input.scopeId,
					key: input.key,
					valueJson,
					updatedBy: input.updatedBy,
					updatedAt,
				})
				.returning()
				.get();
		} else {
			// Update existing row.
			row = handle.db
				.update(settings)
				.set({ valueJson, updatedBy: input.updatedBy, updatedAt })
				.where(eq(settings.id, existing.id))
				.returning()
				.get();
		}

		// Audit event in the SAME writer link (emitInWriter — not emitEvent).
		const auditPayload: Record<string, unknown> = {
			scope: input.scope,
			scopeId: input.scopeId,
			key: input.key,
			updatedBy: input.updatedBy,
			hadPrevious,
		};
		// BLUEPRINT §3.12.7: never put secret values in events.
		if (!def.secret) {
			auditPayload.newValue = input.value;
		}
		log.emitInWriter({ kind: "settings.updated", payload: auditPayload });

		return row;
	});

	return { ok: true, row: toView(resultRow, def) };
}

// ---------------------------------------------------------------------------
// deleteSetting — revert to default
// ---------------------------------------------------------------------------

export interface DeleteSettingInput {
	scope: SettingScope;
	scopeId: number | null;
	key: string;
	updatedBy: string;
}

export type DeleteSettingResult =
	| { ok: true }
	| { ok: false; reason: "not_found"; message: string };

/**
 * Delete a settings row (revert to default). Emits "settings.reverted" in the
 * same writer-queue link as the DELETE. Returns not_found if the row is absent.
 */
export async function deleteSetting(
	handle: DbHandle,
	log: EventLog,
	input: DeleteSettingInput,
): Promise<DeleteSettingResult> {
	const result = await enqueueWrite((): "not_found" | "ok" => {
		const existing = getSetting(handle, input.scope, input.scopeId, input.key);
		if (existing === null) return "not_found";

		handle.db.delete(settings).where(eq(settings.id, existing.id)).run();

		log.emitInWriter({
			kind: "settings.reverted",
			payload: {
				scope: input.scope,
				scopeId: input.scopeId,
				key: input.key,
				updatedBy: input.updatedBy,
			},
		});
		return "ok";
	});

	if (result === "not_found") {
		return {
			ok: false,
			reason: "not_found",
			message: `no settings row found for scope="${input.scope}" scopeId=${input.scopeId} key="${input.key}"`,
		};
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// resolveEffectiveConfig — layered DB override on top of file+env base
// ---------------------------------------------------------------------------

export type ProvenanceSource = "default" | "file" | "env" | "db:global" | "db:project" | "db:routine";
export type ProvenanceMap = Record<string, ProvenanceSource>;

export interface EffectiveConfigResult {
	config: NightshiftConfig;
	provenance: ProvenanceMap;
}

/**
 * Compose the effective NightshiftConfig by applying DB settings on top of the
 * caller-supplied `base` (which has already had file+env overrides applied and
 * comes with its own provenance map from loadConfigWithSources).
 *
 * Application order: base (default/file/env) → DB global → DB project →
 * DB routine. Each layer wins over the previous. Only REGISTRY keys can be
 * applied; unknown DB rows are silently ignored (fail-closed: a mistyped key
 * doesn't fabricate a broken config path).
 *
 * Dotted-path writes use a two-level path (section.leaf) matching how
 * NightshiftConfig is structured. A three-or-more-segment path is unsupported
 * and skipped (future-proofing guard).
 */
export function resolveEffectiveConfig(
	handle: DbHandle,
	base: NightshiftConfig,
	opts?: {
		projectId?: number | null;
		routineId?: number | null;
		/** Caller-supplied provenance from loadConfigWithSources().sources. */
		baseProvenance?: Record<string, "default" | "file" | "env">;
	},
): EffectiveConfigResult {
	// Deep-clone the base so mutations don't bleed back to the caller.
	const config = structuredClone(base) as NightshiftConfig;

	// Seed provenance from the caller-supplied base map (or default everything).
	const provenance: ProvenanceMap = {};
	if (opts?.baseProvenance) {
		for (const [k, v] of Object.entries(opts.baseProvenance)) {
			provenance[k] = v;
		}
	} else {
		// Fall back: mark every REGISTRY key as "default".
		for (const key of Object.keys(REGISTRY)) {
			provenance[key] = "default";
		}
	}

	// Helper: apply a single row to `config` + `provenance`.
	function applyRow(row: SettingRow, source: ProvenanceSource): void {
		const def = REGISTRY[row.key];
		if (!def) return; // unknown key — ignore.

		const parts = def.configPath.split(".");
		if (parts.length !== 2) return; // unsupported depth — guard.
		const [section, leaf] = parts as [string, string];

		const decoded = decodeValue(row.valueJson);
		const validation = def.validate(decoded);
		if (!validation.ok) return; // invalid stored value — ignore (fail-closed).

		// Apply only if config[section] is an object (type guard).
		const sectionObj = (config as unknown as Record<string, Record<string, unknown>>)[section];
		if (sectionObj === null || typeof sectionObj !== "object" || Array.isArray(sectionObj)) return;
		sectionObj[leaf] = decoded;
		provenance[def.configPath] = source;
	}

	// 1. DB global (scope=global, scope_id IS NULL).
	const globalRows = handle.db
		.select()
		.from(settings)
		.where(and(eq(settings.scope, "global"), isNull(settings.scopeId)))
		.all();
	for (const row of globalRows) applyRow(row, "db:global");

	// 2. DB project override.
	if (opts?.projectId != null) {
		const projectRows = handle.db
			.select()
			.from(settings)
			.where(and(eq(settings.scope, "project"), eq(settings.scopeId, opts.projectId)))
			.all();
		for (const row of projectRows) applyRow(row, "db:project");
	}

	// 3. DB routine override.
	if (opts?.routineId != null) {
		const routineRows = handle.db
			.select()
			.from(settings)
			.where(and(eq(settings.scope, "routine"), eq(settings.scopeId, opts.routineId)))
			.all();
		for (const row of routineRows) applyRow(row, "db:routine");
	}

	return { config, provenance };
}

// ---------------------------------------------------------------------------
// listAuditEvents — query the events table for settings audit rows
// ---------------------------------------------------------------------------

const AUDIT_KINDS = ["settings.updated", "settings.reverted"] as const;

/**
 * Return settings audit events from the global events table, newest first.
 * Optionally limit the result count (default: 100).
 */
export function listAuditEvents(
	handle: DbHandle,
	opts?: { limit?: number },
): import("../db/schema.ts").EventRow[] {
	const limit = opts?.limit ?? 100;
	return handle.db
		.select()
		.from(events)
		.where(inArray(events.kind, [...AUDIT_KINDS]))
		.orderBy(desc(events.seq))
		.limit(limit)
		.all();
}
