/**
 * Experiment ledger tests (UNIT P6-4).
 *
 * Matrix (5 cases):
 *   1. appendLedgerEntry inserts and emits experiment.iteration event.
 *   2. listLedger returns rows in iteration ascending order.
 *   3. metricSeries filters to iteration/metricValue/status and orders asc.
 *   4. bestEntry with direction="lower" selects the kept row with lowest metric.
 *   5. bestEntry with direction="higher" selects the kept row with highest metric.
 *      Edge: no kept rows or all null metrics → null.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { events, runs } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import {
	appendLedgerEntry,
	bestEntry,
	listLedger,
	metricSeries,
	type AppendLedgerEntryInput,
	type MetricPoint,
} from "./ledger.ts";

let handle: DbHandle;
let log: EventLog;

function insertTestRun(id?: number) {
	handle.db
		.insert(runs)
		.values({
			kind: "experiment",
			provider: "test",
			model: "test",
			authLane: "local",
			state: "running",
			...(id ? { id } : {}),
		})
		.run();
}

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
});

afterEach(() => {
	handle.sqlite.close();
});

describe("appendLedgerEntry", () => {
	test("inserts a ledger row and emits experiment.iteration event", async () => {
		insertTestRun(42);
		const input: AppendLedgerEntryInput = {
			routineRunId: 42,
			iteration: 1,
			commitSha: "abc123def456",
			metricName: "loss",
			metricValue: 0.5,
			status: "keep",
			description: "kept: loss=0.5 (lower)",
		};

		const row = await appendLedgerEntry(handle, log, input);

		expect(row.routineRunId).toBe(42);
		expect(row.iteration).toBe(1);
		expect(row.commitSha).toBe("abc123def456");
		expect(row.metricName).toBe("loss");
		expect(row.metricValue).toBe(0.5);
		expect(row.status).toBe("keep");
		expect(row.description).toBe("kept: loss=0.5 (lower)");
		expect(row.createdAt).toBeDefined();

		// Verify event was emitted
		const emitted = handle.db.select().from(events).all();
		const expEvent = emitted.find((e) => e.kind === "experiment.iteration");
		expect(expEvent).toBeDefined();
		expect(expEvent?.runId).toBe(42);
	});

	test("event payload carries metric/commit/status only — never the description (§3.12.7)", async () => {
		insertTestRun(45);
		// A description that embeds a secret-looking token. The description is a
		// legitimate ledger column (operator audit), but it MUST NOT be copied into
		// the emitted event payload — events fan out widely (SSE) and never carry
		// secrets/free-text reasons.
		const SECRET = "sk-LIVE-0987654321deadbeef";
		await appendLedgerEntry(handle, log, {
			routineRunId: 45,
			iteration: 1,
			commitSha: "c0ffee",
			metricName: "loss",
			metricValue: 0.42,
			status: "keep",
			memoryNote: `note containing ${SECRET}`,
			description: `kept; raw eval said ${SECRET}`,
		});

		const emitted = handle.db.select().from(events).all();
		const expEvents = emitted.filter((e) => e.kind === "experiment.iteration");
		expect(expEvents).toHaveLength(1);
		const payload = expEvents[0]!.payloadJson;
		// The audit fields ARE present.
		expect(payload).toContain("loss");
		expect(payload).toContain("c0ffee");
		expect(payload).toContain("keep");
		// The free-text description / memoryNote / secret are NOT.
		expect(payload).not.toContain(SECRET);
		expect(payload).not.toContain("description");
		expect(payload).not.toContain("memoryNote");
		expect(payload).not.toContain("memory_note");
	});

	test("handles nullable commitSha and metricValue", async () => {
		insertTestRun(43);
		const input: AppendLedgerEntryInput = {
			routineRunId: 43,
			iteration: 2,
			// no commitSha
			metricName: "accuracy",
			// no metricValue
			status: "crash",
			description: "crash: eval failed",
		};

		const row = await appendLedgerEntry(handle, log, input);

		expect(row.commitSha).toBeNull();
		expect(row.metricValue).toBeNull();
		expect(row.status).toBe("crash");
	});

	test("stamps createdAt with ISO string", async () => {
		insertTestRun(44);
		const input: AppendLedgerEntryInput = {
			routineRunId: 44,
			iteration: 3,
			metricName: "f1",
			metricValue: 0.75,
			status: "keep",
			description: "test",
		};

		const row = await appendLedgerEntry(handle, log, input);

		// createdAt should be a valid ISO string
		const date = new Date(row.createdAt);
		expect(!isNaN(date.getTime())).toBe(true);
	});
});

describe("listLedger", () => {
	test("returns rows in iteration ascending order", async () => {
		insertTestRun(100);
		// Insert in non-sequential order
		await appendLedgerEntry(handle, log, {
			routineRunId: 100,
			iteration: 3,
			metricName: "loss",
			metricValue: 0.3,
			status: "keep",
			description: "iter 3",
		});

		await appendLedgerEntry(handle, log, {
			routineRunId: 100,
			iteration: 1,
			metricName: "loss",
			metricValue: 0.5,
			status: "keep",
			description: "iter 1",
		});

		await appendLedgerEntry(handle, log, {
			routineRunId: 100,
			iteration: 2,
			metricName: "loss",
			metricValue: 0.4,
			status: "discard",
			description: "iter 2",
		});

		const rows = listLedger(handle, 100);

		expect(rows).toHaveLength(3);
		expect(rows[0]?.iteration).toBe(1);
		expect(rows[1]?.iteration).toBe(2);
		expect(rows[2]?.iteration).toBe(3);
	});

	test("filters by routineRunId", async () => {
		insertTestRun(101);
		insertTestRun(102);
		await appendLedgerEntry(handle, log, {
			routineRunId: 101,
			iteration: 1,
			metricName: "loss",
			metricValue: 0.5,
			status: "keep",
			description: "run 101",
		});

		await appendLedgerEntry(handle, log, {
			routineRunId: 102,
			iteration: 1,
			metricName: "loss",
			metricValue: 0.6,
			status: "keep",
			description: "run 102",
		});

		const rows101 = listLedger(handle, 101);
		const rows102 = listLedger(handle, 102);

		expect(rows101).toHaveLength(1);
		expect(rows101[0]?.routineRunId).toBe(101);
		expect(rows102).toHaveLength(1);
		expect(rows102[0]?.routineRunId).toBe(102);
	});

	test("returns empty array for nonexistent routineRunId", () => {
		const rows = listLedger(handle, 999);
		expect(rows).toHaveLength(0);
	});
});

describe("metricSeries", () => {
	test("maps ledger rows to MetricPoint[] with iteration/metricValue/status", async () => {
		insertTestRun(200);
		await appendLedgerEntry(handle, log, {
			routineRunId: 200,
			iteration: 1,
			metricName: "loss",
			metricValue: 0.5,
			status: "keep",
			description: "iter 1",
		});

		await appendLedgerEntry(handle, log, {
			routineRunId: 200,
			iteration: 2,
			metricName: "loss",
			metricValue: null,
			status: "crash",
			description: "iter 2",
		});

		const series = metricSeries(handle, 200);

		expect(series).toHaveLength(2);
		expect(series[0]).toEqual({
			iteration: 1,
			metricValue: 0.5,
			status: "keep",
		});
		expect(series[1]).toEqual({
			iteration: 2,
			metricValue: null,
			status: "crash",
		});
	});

	test("returns empty array for nonexistent routineRunId", () => {
		const series = metricSeries(handle, 999);
		expect(series).toHaveLength(0);
	});
});

describe("bestEntry with direction='lower'", () => {
	test("selects the kept row with the lowest metric", async () => {
		insertTestRun(300);
		const rows = [
			await appendLedgerEntry(handle, log, {
				routineRunId: 300,
				iteration: 1,
				metricName: "loss",
				metricValue: 0.8,
				status: "keep",
				description: "kept 0.8",
			}),
			await appendLedgerEntry(handle, log, {
				routineRunId: 300,
				iteration: 2,
				metricName: "loss",
				metricValue: 0.5,
				status: "keep",
				description: "kept 0.5",
			}),
			await appendLedgerEntry(handle, log, {
				routineRunId: 300,
				iteration: 3,
				metricName: "loss",
				metricValue: 0.6,
				status: "keep",
				description: "kept 0.6",
			}),
		];

		const best = bestEntry(rows, "lower");

		expect(best).toBeDefined();
		expect(best?.iteration).toBe(2);
		expect(best?.metricValue).toBe(0.5);
	});

	test("ignores discard and crash rows", async () => {
		insertTestRun(301);
		const rows = [
			await appendLedgerEntry(handle, log, {
				routineRunId: 301,
				iteration: 1,
				metricName: "loss",
				metricValue: 0.4,
				status: "discard",
				description: "discarded 0.4",
			}),
			await appendLedgerEntry(handle, log, {
				routineRunId: 301,
				iteration: 2,
				metricName: "loss",
				metricValue: null,
				status: "crash",
				description: "crash",
			}),
			await appendLedgerEntry(handle, log, {
				routineRunId: 301,
				iteration: 3,
				metricName: "loss",
				metricValue: 0.9,
				status: "keep",
				description: "kept 0.9",
			}),
		];

		const best = bestEntry(rows, "lower");

		expect(best?.iteration).toBe(3);
		expect(best?.metricValue).toBe(0.9);
	});

	test("returns null when no kept rows have a numeric metric", async () => {
		insertTestRun(302);
		const rows = [
			await appendLedgerEntry(handle, log, {
				routineRunId: 302,
				iteration: 1,
				metricName: "loss",
				metricValue: null,
				status: "keep",
				description: "kept but null",
			}),
			await appendLedgerEntry(handle, log, {
				routineRunId: 302,
				iteration: 2,
				metricName: "loss",
				metricValue: 0.5,
				status: "discard",
				description: "discarded 0.5",
			}),
		];

		const best = bestEntry(rows, "lower");

		expect(best).toBeNull();
	});

	test("returns null for empty array", () => {
		const best = bestEntry([], "lower");
		expect(best).toBeNull();
	});
});

describe("bestEntry with direction='higher'", () => {
	test("selects the kept row with the highest metric", async () => {
		insertTestRun(400);
		const rows = [
			await appendLedgerEntry(handle, log, {
				routineRunId: 400,
				iteration: 1,
				metricName: "accuracy",
				metricValue: 0.8,
				status: "keep",
				description: "kept 0.8",
			}),
			await appendLedgerEntry(handle, log, {
				routineRunId: 400,
				iteration: 2,
				metricName: "accuracy",
				metricValue: 0.95,
				status: "keep",
				description: "kept 0.95",
			}),
			await appendLedgerEntry(handle, log, {
				routineRunId: 400,
				iteration: 3,
				metricName: "accuracy",
				metricValue: 0.9,
				status: "keep",
				description: "kept 0.9",
			}),
		];

		const best = bestEntry(rows, "higher");

		expect(best).toBeDefined();
		expect(best?.iteration).toBe(2);
		expect(best?.metricValue).toBe(0.95);
	});

	test("ignores discard and crash rows", async () => {
		insertTestRun(401);
		const rows = [
			await appendLedgerEntry(handle, log, {
				routineRunId: 401,
				iteration: 1,
				metricName: "accuracy",
				metricValue: 0.99,
				status: "discard",
				description: "discarded 0.99",
			}),
			await appendLedgerEntry(handle, log, {
				routineRunId: 401,
				iteration: 2,
				metricName: "accuracy",
				metricValue: null,
				status: "crash",
				description: "crash",
			}),
			await appendLedgerEntry(handle, log, {
				routineRunId: 401,
				iteration: 3,
				metricName: "accuracy",
				metricValue: 0.7,
				status: "keep",
				description: "kept 0.7",
			}),
		];

		const best = bestEntry(rows, "higher");

		expect(best?.iteration).toBe(3);
		expect(best?.metricValue).toBe(0.7);
	});

	test("returns null when no kept rows have a numeric metric", async () => {
		insertTestRun(402);
		const rows = [
			await appendLedgerEntry(handle, log, {
				routineRunId: 402,
				iteration: 1,
				metricName: "accuracy",
				metricValue: null,
				status: "keep",
				description: "kept but null",
			}),
		];

		const best = bestEntry(rows, "higher");

		expect(best).toBeNull();
	});
});
