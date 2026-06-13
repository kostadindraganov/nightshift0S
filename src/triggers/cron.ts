/**
 * WHY: A small, correct standard 5-field cron evaluator (BLUEPRINT §3.2,
 * §3.10 item 3). Cron triggers fire routines on a wall-clock schedule, so we
 * need to answer two questions deterministically and WITHOUT a dependency:
 *   - "what is the next minute strictly after T that matches this expression?"
 *     (`nextFireTime`) — used by the scheduler to decide when a trigger is due;
 *   - "which enabled cron triggers are due as of `now`?" (`dueTriggers`).
 *
 * The five fields are minute / hour / day-of-month / month / day-of-week, in
 * that order. Supported field syntax: "*", lists "a,b,c", ranges "a-b", steps
 * "*​/n" and "a-b/n". Day-of-week 0 and 7 both mean Sunday (standard cron).
 *
 * DAY MATCHING: per POSIX cron, when BOTH day-of-month and day-of-week are
 * restricted (neither is "*") a day matches if EITHER field matches (the union);
 * when only one is restricted, only that one gates the day. Months are matched
 * 1..12; the JS Date month (0..11) is offset here, not in the parsed set.
 *
 * Everything runs against UTC (Date.getUTC*) so the result is independent of
 * the host timezone — the factory's clock is injected and tests are
 * deterministic. `nextFireTime` iterates minute-by-minute with a bounded
 * horizon (<= 366 days) and returns null if nothing matches in that window
 * (e.g. an impossible date like Feb 30), so it can never loop forever.
 */

import { and, eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { triggers, type TriggerRow } from "../db/schema.ts";

// ---------------------------------------------------------------------------
// Field bounds (inclusive). Index matches the 5 fields in order.
// ---------------------------------------------------------------------------

const FIELD_BOUNDS: ReadonlyArray<{ min: number; max: number; name: string }> = [
	{ min: 0, max: 59, name: "minute" },
	{ min: 0, max: 23, name: "hour" },
	{ min: 1, max: 31, name: "day-of-month" },
	{ min: 1, max: 12, name: "month" },
	{ min: 0, max: 6, name: "day-of-week" }, // 7 normalized to 0 (Sunday).
];

/** Horizon for `nextFireTime` — beyond this we give up (null). */
const MAX_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;

export interface ParsedCron {
	/** Allowed minutes (0..59). */
	minute: ReadonlySet<number>;
	/** Allowed hours (0..23). */
	hour: ReadonlySet<number>;
	/** Allowed days-of-month (1..31). */
	dayOfMonth: ReadonlySet<number>;
	/** Allowed months (1..12). */
	month: ReadonlySet<number>;
	/** Allowed days-of-week (0..6, Sunday=0). */
	dayOfWeek: ReadonlySet<number>;
	/** True when the field was a bare "*" (used for the DOM/DOW union rule). */
	domRestricted: boolean;
	dowRestricted: boolean;
}

// ---------------------------------------------------------------------------
// parseCron
// ---------------------------------------------------------------------------

/**
 * Parse a single field into its set of allowed values. Throws on any value
 * outside [min,max], a malformed step/range, or a non-positive step — invalid
 * input must FAIL CLOSED at parse time, never silently match nothing.
 */
function parseField(raw: string, min: number, max: number, name: string): Set<number> {
	const out = new Set<number>();
	for (const part of raw.split(",")) {
		const piece = part.trim();
		if (piece.length === 0) throw new Error(`cron: empty term in ${name} field`);

		// Split an optional step: "<range-or-star>/<n>".
		let rangePart = piece;
		let step = 1;
		const slash = piece.indexOf("/");
		if (slash !== -1) {
			rangePart = piece.slice(0, slash);
			const stepRaw = piece.slice(slash + 1);
			step = Number(stepRaw);
			if (!Number.isInteger(step) || step <= 0) {
				throw new Error(`cron: invalid step '${stepRaw}' in ${name} field`);
			}
		}

		// Resolve the base range the step walks over.
		let lo: number;
		let hi: number;
		if (rangePart === "*") {
			lo = min;
			hi = max;
		} else {
			const dash = rangePart.indexOf("-");
			if (dash === -1) {
				lo = hi = parseValue(rangePart, min, max, name);
				// A bare value with no step is a single point; a value with a step
				// ("n/step") means "from n to max by step" (standard cron).
				if (slash !== -1) hi = max;
			} else {
				lo = parseValue(rangePart.slice(0, dash), min, max, name);
				hi = parseValue(rangePart.slice(dash + 1), min, max, name);
				if (lo > hi) throw new Error(`cron: inverted range '${rangePart}' in ${name} field`);
			}
		}

		for (let v = lo; v <= hi; v += step) out.add(v);
	}
	if (out.size === 0) throw new Error(`cron: ${name} field matched no values`);
	return out;
}

/** Parse one integer term, bounds-checked, with day-of-week 7 → 0 normalization. */
function parseValue(raw: string, min: number, max: number, name: string): number {
	const trimmed = raw.trim();
	// Reject empties up front: `Number("")` coerces to 0, which would let a
	// malformed term (e.g. "-1" splitting on its leading "-" into lo="") sneak in
	// as a valid bound. Fail closed on a missing/non-numeric term instead.
	if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
		throw new Error(`cron: '${raw}' is not an integer in ${name} field`);
	}
	const n = Number(trimmed);
	if (!Number.isInteger(n)) throw new Error(`cron: '${raw}' is not an integer in ${name} field`);
	// Day-of-week 7 is Sunday too; fold to 0 before the bounds check (max is 6).
	const v = name === "day-of-week" && n === 7 ? 0 : n;
	if (v < min || v > max) {
		throw new Error(`cron: ${name} value ${n} out of range ${min}-${max}`);
	}
	return v;
}

/**
 * Parse a standard 5-field cron expression. Throws on the wrong field count or
 * any malformed field — callers treat a throw as "invalid schedule".
 */
export function parseCron(expr: string): ParsedCron {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(`cron: expected 5 fields, got ${fields.length} ('${expr}')`);
	}
	const sets = fields.map((field, i) =>
		parseField(field, FIELD_BOUNDS[i]!.min, FIELD_BOUNDS[i]!.max, FIELD_BOUNDS[i]!.name),
	);
	return {
		minute: sets[0]!,
		hour: sets[1]!,
		dayOfMonth: sets[2]!,
		month: sets[3]!,
		dayOfWeek: sets[4]!,
		domRestricted: fields[2] !== "*",
		dowRestricted: fields[4] !== "*",
	};
}

// ---------------------------------------------------------------------------
// nextFireTime
// ---------------------------------------------------------------------------

/** Does a parsed cron match this UTC instant (at minute granularity)? */
function matches(parsed: ParsedCron, d: Date): boolean {
	if (!parsed.minute.has(d.getUTCMinutes())) return false;
	if (!parsed.hour.has(d.getUTCHours())) return false;
	if (!parsed.month.has(d.getUTCMonth() + 1)) return false;

	const domOk = parsed.dayOfMonth.has(d.getUTCDate());
	const dowOk = parsed.dayOfWeek.has(d.getUTCDay());
	// POSIX day rule: both restricted → union (either); else AND of the two
	// (an unrestricted "*" field is always true, so AND collapses correctly).
	if (parsed.domRestricted && parsed.dowRestricted) return domOk || dowOk;
	return domOk && dowOk;
}

/**
 * Next minute STRICTLY after `after` that matches `expr`, or null if no match
 * within the 366-day horizon. Iterates minute-by-minute on a UTC clock with
 * the seconds/millis zeroed; an invalid expression propagates the parse throw.
 */
export function nextFireTime(expr: string, after: Date): Date | null {
	const parsed = parseCron(expr);
	// Start at the next whole minute strictly after `after`.
	const cursor = new Date(after.getTime());
	cursor.setUTCSeconds(0, 0);
	cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

	const deadline = after.getTime() + MAX_HORIZON_MS;
	while (cursor.getTime() <= deadline) {
		if (matches(parsed, cursor)) return new Date(cursor.getTime());
		cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
	}
	return null;
}

// ---------------------------------------------------------------------------
// dueTriggers
// ---------------------------------------------------------------------------

/**
 * Enabled cron triggers whose next fire time is at-or-before `now`. The "after"
 * baseline is `last_fired_at` when present, else the trigger's epoch-0 base so
 * a brand-new schedule fires on its first matching minute. A trigger with a
 * null/unparseable schedule, or one whose `nextFireTime` can't resolve, is
 * skipped (fail-closed — never fire on a schedule we couldn't evaluate).
 */
export function dueTriggers(handle: DbHandle, now: Date): TriggerRow[] {
	const rows = handle.db
		.select()
		.from(triggers)
		.where(and(eq(triggers.kind, "cron"), eq(triggers.enabled, true)))
		.all();

	const due: TriggerRow[] = [];
	for (const row of rows) {
		if (row.schedule === null || row.schedule === "") continue;
		const after = parseAfter(row.lastFiredAt);
		let next: Date | null;
		try {
			next = nextFireTime(row.schedule, after);
		} catch {
			continue; // invalid expression — skip rather than throw a scheduler tick.
		}
		if (next !== null && next.getTime() <= now.getTime()) due.push(row);
	}
	return due;
}

/** lastFiredAt → the Date to search after; epoch-0 base when never fired/corrupt. */
function parseAfter(lastFiredAt: string | null): Date {
	if (lastFiredAt === null || lastFiredAt === "") return new Date(0);
	const t = Date.parse(lastFiredAt);
	return Number.isNaN(t) ? new Date(0) : new Date(t);
}
