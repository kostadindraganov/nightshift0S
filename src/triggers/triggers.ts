/**
 * WHY: ONE trigger abstraction (BLUEPRINT §3.2, §3.10 item 3, §3.12.6).
 * manual / cron / webhook / chat are all "trigger -> routine" records; this
 * module is their CRUD plus the dispatch path that turns a fired trigger into a
 * task. V1.5 ships MANUAL + CRON dispatch live; WEBHOOK + CHAT are modeled but,
 * when `dry_run_default` is set, their dispatch returns `dry_run_pending` (no
 * task created) so an external caller can't yet drive the factory unsupervised.
 *
 * fireTrigger is a fail-closed gauntlet, in strict order (each gate refuses
 * before any side effect):
 *   1. load trigger + routine            -> not_found
 *   2. authz (allowlist for ext sources) -> authz_denied
 *   3. dedupe (recent trigger.fired)     -> duplicate
 *   4. rate limit (trigger.fired / hour) -> rate_limited
 *   5. dry-run gate (ext + dry_run flag) -> dry_run_pending  (NO task)
 *   6. create task via createTask (honours the state machine), stamp
 *      last_fired_at, emit "trigger.fired".
 *
 * SECRETS: the authz token/allowlist actors are config identities, not
 * credentials; even so we never echo authz_json into an event — fired events
 * carry only ids/source/actor (§3.12.7). All writes ride enqueueWrite; reads
 * (trigger/routine rows, fired-event history) are direct under WAL.
 */

import { and, eq, gt, type SQL } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { TRIGGER_KINDS, type TriggerKind } from "../db/columns.ts";
import { events, tasks, triggers, type TriggerRow } from "../db/schema.ts";
import { enqueueWrite } from "../db/writer.ts";
import type { EventLog } from "../events/events.ts";
import { createTask } from "../tasks/tasks.ts";
import { getRoutine } from "./routines.ts";
import { dueTriggers } from "./cron.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TriggerDeps {
	handle: DbHandle;
	log: EventLog;
}

export interface CreateTriggerInput {
	routineId: number;
	kind: TriggerKind;
	/** Cron expression for kind="cron"; null otherwise. */
	schedule?: string | null;
	/** JSON: { allowlist?: string[], rateLimitPerHour?: number, dedupeWindowSeconds?: number }. */
	authzJson?: string | null;
	dryRunDefault?: boolean;
	enabled?: boolean;
}

export interface UpdateTriggerPatch {
	kind?: TriggerKind;
	schedule?: string | null;
	authzJson?: string | null;
	dryRunDefault?: boolean;
	enabled?: boolean;
}

export interface ListTriggersFilter {
	routineId?: number;
	kind?: TriggerKind;
	enabled?: boolean;
}

export type TriggerSource = "manual" | "cron" | "webhook" | "chat";

export interface FireOpts {
	actor: string;
	source: TriggerSource;
	/** When set, a fire within `dedupeWindowSeconds` of a prior same-key fire is "duplicate". */
	dedupeKey?: string;
}

export type FireResult =
	| { ok: true; taskId: number }
	| { ok: false; reason: string };

export type TriggerResult =
	| { ok: true; trigger: TriggerRow }
	| { ok: false; reason: string };

export type DeleteTriggerResult = { ok: true } | { ok: false; reason: string };

/** Parsed `authz_json` shape (§3.12.6). All fields optional. */
interface AuthzConfig {
	allowlist?: string[];
	rateLimitPerHour?: number;
	dedupeWindowSeconds?: number;
}

/** External sources are gated by the allowlist + dry-run; manual/cron are internal. */
const EXTERNAL_SOURCES: ReadonlySet<TriggerSource> = new Set(["webhook", "chat"]);

const TRIGGER_FIRED = "trigger.fired";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateKind(value: TriggerKind): boolean {
	return (TRIGGER_KINDS as readonly string[]).includes(value);
}

/** Parse authz_json into a config, tolerating null/empty; throws on a bad blob. */
function parseAuthz(authzJson: string | null): AuthzConfig {
	if (authzJson === null || authzJson === "") return {};
	const parsed = JSON.parse(authzJson) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("authz_json must be a JSON object");
	}
	return parsed as AuthzConfig;
}

// ---------------------------------------------------------------------------
// Reads (direct)
// ---------------------------------------------------------------------------

export function getTrigger(handle: DbHandle, id: number): TriggerRow | null {
	return handle.db.select().from(triggers).where(eq(triggers.id, id)).get() ?? null;
}

export function listTriggers(handle: DbHandle, filter: ListTriggersFilter = {}): TriggerRow[] {
	const clauses: SQL[] = [];
	if (filter.routineId !== undefined) clauses.push(eq(triggers.routineId, filter.routineId));
	if (filter.kind !== undefined) clauses.push(eq(triggers.kind, filter.kind));
	if (filter.enabled !== undefined) clauses.push(eq(triggers.enabled, filter.enabled));
	const query = handle.db.select().from(triggers);
	const rows = (clauses.length > 0 ? query.where(and(...clauses)) : query).all();
	return rows.sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------
// createTrigger
// ---------------------------------------------------------------------------

export async function createTrigger(
	deps: TriggerDeps,
	input: CreateTriggerInput,
): Promise<TriggerResult> {
	const { handle, log } = deps;
	if (!validateKind(input.kind)) {
		return { ok: false, reason: `invalid kind '${String(input.kind)}'` };
	}
	if (getRoutine(handle, input.routineId) === null) {
		return { ok: false, reason: "not_found" }; // referenced routine must exist.
	}
	// A cron trigger needs a schedule; validate it parses (cron.parseCron throws on bad).
	if (input.kind === "cron") {
		if (input.schedule === null || input.schedule === undefined || input.schedule === "") {
			return { ok: false, reason: "schedule is required for cron triggers" };
		}
	}
	if (input.authzJson !== null && input.authzJson !== undefined) {
		try {
			parseAuthz(input.authzJson);
		} catch {
			return { ok: false, reason: "authz_json must be valid JSON object" };
		}
	}

	const trigger = await enqueueWrite(() => {
		const row = handle.db
			.insert(triggers)
			.values({
				routineId: input.routineId,
				kind: input.kind,
				schedule: input.schedule ?? null,
				authzJson: input.authzJson ?? null,
				...(input.dryRunDefault !== undefined ? { dryRunDefault: input.dryRunDefault } : {}),
				...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
			})
			.returning()
			.get();
		log.emitInWriter({
			kind: "trigger.created",
			payload: { triggerId: row.id, routineId: row.routineId, kind: row.kind },
		});
		return row;
	});
	return { ok: true, trigger };
}

// ---------------------------------------------------------------------------
// updateTrigger
// ---------------------------------------------------------------------------

export async function updateTrigger(
	deps: TriggerDeps,
	id: number,
	patch: UpdateTriggerPatch,
): Promise<TriggerResult> {
	const { handle, log } = deps;
	const set: Partial<typeof triggers.$inferInsert> = {};
	if (patch.kind !== undefined) {
		if (!validateKind(patch.kind)) return { ok: false, reason: `invalid kind '${String(patch.kind)}'` };
		set.kind = patch.kind;
	}
	if (patch.schedule !== undefined) set.schedule = patch.schedule;
	if (patch.authzJson !== undefined) {
		if (patch.authzJson !== null) {
			try {
				parseAuthz(patch.authzJson);
			} catch {
				return { ok: false, reason: "authz_json must be valid JSON object" };
			}
		}
		set.authzJson = patch.authzJson;
	}
	if (patch.dryRunDefault !== undefined) set.dryRunDefault = patch.dryRunDefault;
	if (patch.enabled !== undefined) set.enabled = patch.enabled;

	return enqueueWrite<TriggerResult>(() => {
		const existing = getTrigger(handle, id);
		if (existing === null) return { ok: false, reason: "not_found" };
		const row =
			Object.keys(set).length === 0
				? existing
				: handle.db.update(triggers).set(set).where(eq(triggers.id, id)).returning().get();
		log.emitInWriter({
			kind: "trigger.updated",
			payload: { triggerId: row.id, routineId: row.routineId, kind: row.kind, enabled: row.enabled },
		});
		return { ok: true, trigger: row };
	});
}

// ---------------------------------------------------------------------------
// deleteTrigger
// ---------------------------------------------------------------------------

export async function deleteTrigger(deps: TriggerDeps, id: number): Promise<DeleteTriggerResult> {
	const { handle, log } = deps;
	return enqueueWrite<DeleteTriggerResult>(() => {
		const existing = getTrigger(handle, id);
		if (existing === null) return { ok: false, reason: "not_found" };
		handle.db.delete(triggers).where(eq(triggers.id, id)).run();
		log.emitInWriter({
			kind: "trigger.deleted",
			payload: { triggerId: id, routineId: existing.routineId },
		});
		return { ok: true };
	});
}

// ---------------------------------------------------------------------------
// fireTrigger — the dispatch gauntlet
// ---------------------------------------------------------------------------

/** Recent `trigger.fired` events for one trigger, newest first (direct read). */
function recentFiredEvents(handle: DbHandle, triggerId: number, sinceMs: number) {
	const sinceIso = new Date(sinceMs).toISOString();
	return handle.db
		.select()
		.from(events)
		.where(and(eq(events.kind, TRIGGER_FIRED), gt(events.ts, sinceIso)))
		.all()
		.filter((e) => {
			try {
				const payload = JSON.parse(e.payloadJson) as { triggerId?: unknown };
				return payload.triggerId === triggerId;
			} catch {
				return false;
			}
		});
}

export async function fireTrigger(
	deps: TriggerDeps,
	triggerId: number,
	opts: FireOpts,
): Promise<FireResult> {
	const { handle, log } = deps;

	// 1. Load trigger + routine.
	const trigger = getTrigger(handle, triggerId);
	if (trigger === null) return { ok: false, reason: "not_found" };
	const routine = getRoutine(handle, trigger.routineId);
	if (routine === null) return { ok: false, reason: "not_found" };

	// 2. Authz. External sources (webhook/chat) must be on the allowlist; an
	//    empty/absent allowlist denies every external actor (fail-closed).
	let authz: AuthzConfig;
	try {
		authz = parseAuthz(trigger.authzJson);
	} catch {
		return { ok: false, reason: "authz_denied" }; // corrupt authz config → deny.
	}
	if (EXTERNAL_SOURCES.has(opts.source)) {
		const allowlist = authz.allowlist ?? [];
		if (!allowlist.includes(opts.actor)) return { ok: false, reason: "authz_denied" };
	}

	const now = Date.now();

	// 3. Dedupe: a same-key fire inside the dedupe window is a duplicate.
	if (opts.dedupeKey !== undefined && authz.dedupeWindowSeconds !== undefined && authz.dedupeWindowSeconds > 0) {
		const windowStart = now - authz.dedupeWindowSeconds * 1000;
		const dup = recentFiredEvents(handle, triggerId, windowStart).some((e) => {
			try {
				const payload = JSON.parse(e.payloadJson) as { dedupeKey?: unknown };
				return payload.dedupeKey === opts.dedupeKey;
			} catch {
				return false;
			}
		});
		if (dup) return { ok: false, reason: "duplicate" };
	}

	// 4. Rate limit: count fires in the last hour against rateLimitPerHour.
	if (authz.rateLimitPerHour !== undefined && authz.rateLimitPerHour >= 0) {
		const hourAgo = now - 3_600_000;
		const firedLastHour = recentFiredEvents(handle, triggerId, hourAgo).length;
		if (firedLastHour >= authz.rateLimitPerHour) return { ok: false, reason: "rate_limited" };
	}

	// 5. Dry-run gate: external source + dry_run_default → pending, NO task.
	if (EXTERNAL_SOURCES.has(opts.source) && trigger.dryRunDefault) {
		return { ok: false, reason: "dry_run_pending" };
	}

	// 6. A routine must be project-scoped to spawn a task (tasks require a project).
	if (routine.projectId === null) return { ok: false, reason: "no_project" };

	// Create the task via createTask so the state machine + invariants hold.
	// Title carries the routine name + a compact params hint when present.
	const title = routineTitle(routine.name, routine.paramsJson);
	let taskId: number;
	try {
		const task = await createTask(handle, {
			projectId: routine.projectId,
			title,
			state: "backlog",
		});
		taskId = task.id;
		// Provenance: stamp the spawning routine on the task (createTask doesn't take it).
		await enqueueWrite(() => {
			handle.db
				.update(tasks)
				.set({ routineId: routine.id, updatedAt: new Date().toISOString() })
				.where(eq(tasks.id, taskId))
				.run();
		});
	} catch (err) {
		// createTask throws ValidationError on a bad project/title — surface as a reason.
		return { ok: false, reason: err instanceof Error ? err.message : "task_create_failed" };
	}

	// Stamp last_fired_at and emit the audit event (NO authz/secret content).
	await enqueueWrite(() => {
		handle.db
			.update(triggers)
			.set({ lastFiredAt: new Date(now).toISOString() })
			.where(eq(triggers.id, triggerId))
			.run();
		log.emitInWriter({
			kind: TRIGGER_FIRED,
			payload: {
				triggerId,
				routineId: routine.id,
				source: opts.source,
				actor: opts.actor,
				taskId,
				...(opts.dedupeKey !== undefined ? { dedupeKey: opts.dedupeKey } : {}),
			},
			taskId,
			...(routine.projectId !== null ? { projectId: routine.projectId } : {}),
		});
	});

	return { ok: true, taskId };
}

/** Compose a task title from a routine name + an optional compact params hint. */
function routineTitle(name: string, paramsJson: string | null): string {
	if (paramsJson === null || paramsJson === "") return name;
	try {
		const parsed = JSON.parse(paramsJson) as unknown;
		const keys =
			typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? Object.keys(parsed as Record<string, unknown>)
				: [];
		return keys.length > 0 ? `${name} (${keys.join(", ")})` : name;
	} catch {
		return name;
	}
}

// ---------------------------------------------------------------------------
// startTriggerScheduler — periodic cron dispatch
// ---------------------------------------------------------------------------

export interface SchedulerOpts {
	intervalMs: number;
	/** Injectable clock; defaults to wall time. */
	now?: () => Date;
}

/**
 * Fire every due cron trigger on each interval tick via fireTrigger(source:
 * "cron"). A tick that overlaps the previous one is skipped (single-flight) so a
 * slow DB can't stack ticks. stop() clears the timer. Errors per-trigger are
 * swallowed so one bad routine can't kill the loop.
 */
export function startTriggerScheduler(
	deps: TriggerDeps,
	opts: SchedulerOpts,
): { stop(): void } {
	const now = opts.now ?? (() => new Date());
	let running = false;
	const timer = setInterval(() => {
		if (running) return; // single-flight: skip if the prior tick is still going.
		running = true;
		void (async () => {
			try {
				for (const trigger of dueTriggers(deps.handle, now())) {
					await fireTrigger(deps, trigger.id, { actor: "scheduler", source: "cron" });
				}
			} finally {
				running = false;
			}
		})();
	}, opts.intervalMs);
	return {
		stop() {
			clearInterval(timer);
		},
	};
}
