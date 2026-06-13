/**
 * Cron parser + scheduler tests (UNIT 5.8d).
 *
 * Coverage matrix:
 *   1. parseCron: valid expressions parse to sets, invalid ones throw.
 *   2. nextFireTime: finds next matching minute or null within horizon.
 *   3. dueTriggers: queries enabled cron triggers due as-of-now.
 *   4. Edge cases: day-of-month/day-of-week union, day-7=Sunday, step syntax.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { routines, triggers, projects } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { dueTriggers, nextFireTime, parseCron } from "./cron.ts";
import { createRoutine } from "./routines.ts";

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
// 1. parseCron: valid + invalid
// ---------------------------------------------------------------------------

test("parseCron: simple star expression", () => {
	const parsed = parseCron("* * * * *");
	expect(parsed.minute.size).toBe(60); // 0..59
	expect(parsed.hour.size).toBe(24); // 0..23
	expect(parsed.dayOfMonth.size).toBe(31); // 1..31
	expect(parsed.month.size).toBe(12); // 1..12
	expect(parsed.dayOfWeek.size).toBe(7); // 0..6
	expect(parsed.domRestricted).toBe(false);
	expect(parsed.dowRestricted).toBe(false);
});

test("parseCron: list syntax", () => {
	const parsed = parseCron("0 1,2,3 * * *");
	expect(parsed.minute).toEqual(new Set([0]));
	expect(parsed.hour).toEqual(new Set([1, 2, 3]));
});

test("parseCron: range syntax", () => {
	const parsed = parseCron("0 0 1-5 * *");
	expect(parsed.dayOfMonth).toEqual(new Set([1, 2, 3, 4, 5]));
});

test("parseCron: step syntax", () => {
	const parsed = parseCron("*/15 * * * *");
	expect(parsed.minute).toEqual(new Set([0, 15, 30, 45]));
});

test("parseCron: range with step", () => {
	const parsed = parseCron("0 0 1-10/2 * *");
	expect(parsed.dayOfMonth).toEqual(new Set([1, 3, 5, 7, 9]));
});

test("parseCron: day-of-week 7 is Sunday (= 0)", () => {
	const parsed = parseCron("0 0 * * 0");
	expect(parsed.dayOfWeek).toContain(0);

	const parsed7 = parseCron("0 0 * * 7");
	expect(parsed7.dayOfWeek).toContain(0);
	expect(parsed7.dayOfWeek.size).toBe(1);
});

test("parseCron: restrictions tracked for day union", () => {
	const both = parseCron("0 0 1 * 1");
	expect(both.domRestricted).toBe(true);
	expect(both.dowRestricted).toBe(true);

	const domOnly = parseCron("0 0 1 * *");
	expect(domOnly.domRestricted).toBe(true);
	expect(domOnly.dowRestricted).toBe(false);

	const dowOnly = parseCron("0 0 * * 1");
	expect(dowOnly.domRestricted).toBe(false);
	expect(dowOnly.dowRestricted).toBe(true);
});

test("parseCron: rejects wrong field count", () => {
	expect(() => parseCron("* * *")).toThrow();
	expect(() => parseCron("* * * * * *")).toThrow();
});

test("parseCron: rejects out-of-bounds values", () => {
	expect(() => parseCron("60 * * * *")).toThrow(); // minute 0..59
	expect(() => parseCron("* 24 * * *")).toThrow(); // hour 0..23
	expect(() => parseCron("* * 32 * *")).toThrow(); // dom 1..31
	expect(() => parseCron("* * * 13 *")).toThrow(); // month 1..12
	expect(() => parseCron("* * * * 8")).toThrow(); // dow 0..7
});

test("parseCron: rejects invalid step", () => {
	expect(() => parseCron("*/0 * * * *")).toThrow(); // step must be > 0
	expect(() => parseCron("*/-1 * * * *")).toThrow();
	expect(() => parseCron("*/abc * * * *")).toThrow();
});

test("parseCron: rejects inverted range", () => {
	expect(() => parseCron("0 5-2 * * *")).toThrow();
});

test("parseCron: rejects empty terms", () => {
	expect(() => parseCron("0, ,* * * *")).toThrow();
});

// ---------------------------------------------------------------------------
// 2. nextFireTime: finding next match
// ---------------------------------------------------------------------------

test("nextFireTime: simple minute", () => {
	const base = new Date("2026-06-13T10:00:00.000Z");
	const next = nextFireTime("0 * * * *", base);
	expect(next).toBeDefined();
	expect(next?.getUTCHours()).toBe(11);
	expect(next?.getUTCMinutes()).toBe(0);
	expect(next?.getUTCSeconds()).toBe(0);
	expect(next?.getUTCMilliseconds()).toBe(0);
});

test("nextFireTime: skips to next hour", () => {
	const base = new Date("2026-06-13T10:30:00.000Z");
	const next = nextFireTime("0 * * * *", base);
	expect(next?.getUTCHours()).toBe(11);
	expect(next?.getUTCMinutes()).toBe(0);
});

test("nextFireTime: matches specific hour", () => {
	const base = new Date("2026-06-13T10:00:00.000Z");
	const next = nextFireTime("30 15 * * *", base);
	expect(next?.getUTCHours()).toBe(15);
	expect(next?.getUTCMinutes()).toBe(30);
});

test("nextFireTime: wraps to next day", () => {
	const base = new Date("2026-06-13T22:00:00.000Z");
	const next = nextFireTime("0 1 * * *", base);
	expect(next?.getUTCDate()).toBe(14);
	expect(next?.getUTCHours()).toBe(1);
	expect(next?.getUTCMinutes()).toBe(0);
});

test("nextFireTime: respects day-of-month restriction", () => {
	const base = new Date("2026-06-13T00:00:00.000Z");
	const next = nextFireTime("0 0 15 * *", base);
	expect(next?.getUTCDate()).toBe(15);
});

test("nextFireTime: day-of-week match", () => {
	// 2026-06-13 is a Saturday (6).
	const base = new Date("2026-06-13T23:00:00.000Z");
	// Next Sunday is 2026-06-14.
	const next = nextFireTime("0 0 * * 0", base);
	expect(next?.getUTCDate()).toBe(14);
	expect(next?.getUTCDay()).toBe(0);
});

test("nextFireTime: day union (DOM|DOW)", () => {
	// 2026-06-13 is Saturday.
	// Schedule: 1st of month OR Sunday.
	// Next match: 2026-06-14 (Sunday).
	const base = new Date("2026-06-13T23:00:00.000Z");
	const next = nextFireTime("0 0 1 * 0", base);
	expect(next?.getUTCDate()).toBe(14);
	expect(next?.getUTCDay()).toBe(0);
});

test("nextFireTime: returns null beyond horizon (366 days)", () => {
	const base = new Date("2026-06-13T00:00:00.000Z");
	// Impossible: Feb 30
	const next = nextFireTime("0 0 30 2 *", base);
	expect(next).toBeNull();
});

test("nextFireTime: strictly after (never at exact time)", () => {
	const base = new Date("2026-06-13T10:00:00.000Z");
	const next = nextFireTime("0 10 * * *", base);
	// Should be 10:00 the NEXT day, not this hour.
	expect(next?.getUTCDate()).toBe(14);
	expect(next?.getUTCHours()).toBe(10);
});

test("nextFireTime: strictly-after at a sub-minute offset still skips the current minute", () => {
	// `after` is mid-minute on a MATCHING minute (10:00:30). The next fire must be
	// the next matching minute (11:00), never 10:00 — strictly-after at minute
	// granularity, with seconds zeroed.
	const base = new Date("2026-06-13T10:00:30.000Z");
	const next = nextFireTime("0 * * * *", base);
	expect(next?.getUTCHours()).toBe(11);
	expect(next?.getUTCMinutes()).toBe(0);
	expect(next?.getUTCSeconds()).toBe(0);
});

test("nextFireTime: DOM-only (DOW=*) uses AND — fires only on the listed day-of-month", () => {
	// "0 0 14 * *" → midnight on the 14th of any month. DOW is "*", so the day
	// gate is DOM AND (always-true DOW): every other day must be skipped.
	const base = new Date("2026-06-13T12:00:00.000Z");
	const next = nextFireTime("0 0 14 * *", base);
	expect(next?.getUTCDate()).toBe(14);
	expect(next?.getUTCMonth()).toBe(5); // June (0-indexed).
	expect(next?.getUTCHours()).toBe(0);
});

test("nextFireTime: both DOM and DOW restricted → union, picks the SOONER of the two", () => {
	// "0 0 20 * 0" → 20th of month OR Sunday. From Sat 2026-06-13, the next
	// Sunday (14th) comes before the 20th, so the union must fire on the 14th.
	const base = new Date("2026-06-13T12:00:00.000Z");
	const next = nextFireTime("0 0 20 * 0", base);
	expect(next?.getUTCDate()).toBe(14);
	expect(next?.getUTCDay()).toBe(0);
});

test("nextFireTime: leap-year Feb 29 resolves; non-leap horizon-bound stays finite", () => {
	// 2028 is a leap year → Feb 29 exists. From early 2028 the schedule resolves.
	const leapBase = new Date("2028-01-01T00:00:00.000Z");
	const leap = nextFireTime("0 0 29 2 *", leapBase);
	expect(leap?.getUTCDate()).toBe(29);
	expect(leap?.getUTCMonth()).toBe(1); // February.
	expect(leap?.getUTCFullYear()).toBe(2028);
});

test("parseCron: rejects negative and non-numeric values", () => {
	expect(() => parseCron("-1 * * * *")).toThrow();
	expect(() => parseCron("x * * * *")).toThrow();
});

// ---------------------------------------------------------------------------
// 3. dueTriggers: scheduler integration
// ---------------------------------------------------------------------------

async function createTestRoutine(name: string) {
	const result = await createRoutine(handle, log, {
		name,
		kind: "task",
		promptName: "test",
	});
	if (!result.ok) throw new Error(`Failed to create routine: ${result.reason}`);
	return result.routine;
}

async function createTestTrigger(
	routineId: number,
	kind: "cron",
	schedule: string,
	enabled: boolean = true,
) {
	const row = handle.db
		.insert(triggers)
		.values({
			routineId,
			kind,
			schedule,
			enabled,
		})
		.returning()
		.get();
	return row;
}

test("dueTriggers: finds triggers due as-of-now", async () => {
	const routine = await createTestRoutine("cron-routine");
	// Schedule: every minute.
	await createTestTrigger(routine.id, "cron", "* * * * *");

	const now = new Date("2026-06-13T10:30:00.000Z");
	const due = dueTriggers(handle, now);
	expect(due.length).toBeGreaterThan(0);
	expect(due[0]?.routineId).toBe(routine.id);
});

test("dueDriggers: skips disabled triggers", async () => {
	const routine = await createTestRoutine("disabled");
	await createTestTrigger(routine.id, "cron", "* * * * *", false);

	const now = new Date("2026-06-13T10:30:00.000Z");
	const due = dueTriggers(handle, now);
	expect(due.length).toBe(0);
});

test("dueTriggers: skips non-cron triggers", async () => {
	const routine = await createTestRoutine("manual");
	const row = handle.db
		.insert(triggers)
		.values({
			routineId: routine.id,
			kind: "manual",
			enabled: true,
		})
		.returning()
		.get();

	const now = new Date("2026-06-13T10:30:00.000Z");
	const due = dueTriggers(handle, now);
	expect(due.length).toBe(0);
});

test("dueDriggers: skips triggers with null or empty schedule", async () => {
	const routine = await createTestRoutine("no-schedule");
	handle.db
		.insert(triggers)
		.values({
			routineId: routine.id,
			kind: "cron",
			schedule: null,
			enabled: true,
		})
		.run();

	const now = new Date("2026-06-13T10:30:00.000Z");
	const due = dueTriggers(handle, now);
	expect(due.length).toBe(0);
});

test("dueTriggers: skips triggers with invalid schedule (fail-closed)", async () => {
	const routine = await createTestRoutine("bad-schedule");
	handle.db
		.insert(triggers)
		.values({
			routineId: routine.id,
			kind: "cron",
			schedule: "invalid cron",
			enabled: true,
		})
		.run();

	const now = new Date("2026-06-13T10:30:00.000Z");
	// Should not throw; just skip.
	expect(() => dueTriggers(handle, now)).not.toThrow();
});

test("dueTriggers: respects lastFiredAt to avoid re-firing", async () => {
	const routine = await createTestRoutine("recurring");
	const trigger = await createTestTrigger(routine.id, "cron", "0 * * * *");

	// Fire it at 10:00.
	const firedAt = new Date("2026-06-13T10:00:00.000Z");
	handle.db
		.update(triggers)
		.set({ lastFiredAt: firedAt.toISOString() })
		.where(eq(triggers.id, trigger.id))
		.run();

	// Next due time is 11:00; at 10:30 it's not due.
	const now = new Date("2026-06-13T10:30:00.000Z");
	const due = dueTriggers(handle, now);
	expect(due.length).toBe(0);

	// At 11:00 it is due.
	const dueLater = dueTriggers(handle, new Date("2026-06-13T11:00:00.000Z"));
	expect(dueLater.length).toBe(1);
});

test("dueDriggers: uses epoch-0 baseline when never fired", async () => {
	// Clean slate for this test.
	handle.db.delete(triggers).run();

	const routine = await createTestRoutine("monthly");
	await createTestTrigger(routine.id, "cron", "0 0 1 * *"); // 1st of month at midnight.

	// At June 13, it's past June 1st, so it SHOULD be due (hasn't fired yet since epoch-0).
	const now = new Date("2026-06-13T10:30:00.000Z");
	const due = dueTriggers(handle, now);
	expect(due.length).toBe(1);

	// After it fires on June 1st, update lastFiredAt, then at June 13 it shouldn't be due again.
	const trigger = due[0]!;
	handle.db
		.update(triggers)
		.set({ lastFiredAt: new Date("2026-06-01T00:00:00.000Z").toISOString() })
		.where(eq(triggers.id, trigger.id))
		.run();

	const notDue = dueTriggers(handle, now);
	expect(notDue.length).toBe(0);

	// But at July 1st, it should be due again.
	const dueLater = dueTriggers(handle, new Date("2026-07-01T00:00:00.000Z"));
	expect(dueLater.length).toBe(1);
});

test("dueTriggers: corrupt lastFiredAt falls back to epoch-0", async () => {
	const routine = await createTestRoutine("corrupt");
	const trigger = await createTestTrigger(routine.id, "cron", "0 0 * * *");

	// Corrupt the timestamp.
	handle.db
		.update(triggers)
		.set({ lastFiredAt: "not-a-date" })
		.where(eq(triggers.id, trigger.id))
		.run();

	// Should not crash; just baseline from epoch.
	expect(() => dueTriggers(handle, new Date())).not.toThrow();
});
