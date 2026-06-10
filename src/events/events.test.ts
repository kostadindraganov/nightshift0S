/**
 * Verify criteria for task 1.3 (global event log + broker):
 *
 *   1. Gap-free seq under concurrency: 200+ concurrent emitEvent calls from
 *      multiple async contexts → persisted seqs are exactly 1..N.
 *   2. Mid-stream subscriber (afterSeq) sees every event exactly once, in
 *      seq order, across the replay→tail handoff (dedup by seq).
 *   3. Drop-oldest: a slow subscriber with >1024 backlog drops oldest and
 *      increments its dropped counter; every event is still in the DB.
 *   4. Restart semantics: re-open the same DB file, emit again — seq
 *      continues from max(seq), no reuse.
 *
 * File-backed temp DBs (WAL, like production), one per test so each test's
 * seqs start at 1.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { events, type EventRow } from "../db/schema.ts";
import { EventLog } from "./events.ts";

const dirs: string[] = [];
const handles: DbHandle[] = [];

function freshLog(): { handle: DbHandle; log: EventLog; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "nightshift-events-"));
	dirs.push(dir);
	const handle = openDatabase(join(dir, "events.db"));
	handles.push(handle);
	runMigrations(handle);
	return { handle, log: new EventLog(handle), dir };
}

afterAll(() => {
	for (const handle of handles) {
		try {
			handle.sqlite.close();
		} catch {
			// already closed by the restart test
		}
	}
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function persistedSeqs(handle: DbHandle): number[] {
	return handle.db
		.select({ seq: events.seq })
		.from(events)
		.all()
		.map((r) => r.seq)
		.sort((a, b) => a - b);
}

const range = (from: number, to: number): number[] =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);

test("210 concurrent emits from 3 async contexts → seqs exactly 1..210, no gaps/dups", async () => {
	const { handle, log } = freshLog();
	const TOTAL = 210;

	const batch = (offset: number, count: number) =>
		Promise.all(
			Array.from({ length: count }, (_, i) =>
				log.emitEvent({ kind: "stress", payload: { i: offset + i } }),
			),
		);
	const rows = (await Promise.all([batch(0, 70), batch(70, 70), batch(140, 70)])).flat();

	// Every emit resolved with a distinct seq; together they are 1..TOTAL.
	const returned = rows.map((r) => r.seq).sort((a, b) => a - b);
	expect(returned).toEqual(range(1, TOTAL));

	// And the DB agrees: exactly 1..TOTAL persisted, no gaps, no duplicates.
	expect(persistedSeqs(handle)).toEqual(range(1, TOTAL));
});

test("mid-stream subscriber (afterSeq=30) gets every event exactly once, in order", async () => {
	const { log } = freshLog();

	// History: seqs 1..60 fully persisted before the subscriber exists.
	for (let i = 0; i < 60; i++) await log.emitEvent({ kind: "pre", payload: i });

	// Fire 60 more WITHOUT awaiting, then subscribe — some land in the replay
	// snapshot, some in the live tail, with overlap in between (the dedup path).
	const inflight = Promise.all(
		Array.from({ length: 60 }, (_, i) => log.emitEvent({ kind: "post", payload: i })),
	);
	const sub = log.subscribe({ afterSeq: 30 });

	const seen: number[] = [];
	for await (const row of sub) {
		seen.push(row.seq);
		if (row.seq === 120) break;
	}
	sub.close();
	await inflight;

	// Exactly once, in seq order, starting just after afterSeq.
	expect(seen).toEqual(range(31, 120));
	expect(log.subscriberCount()).toBe(0);
});

test("filter predicate applies to both replay and tail", async () => {
	const { log } = freshLog();

	for (let i = 0; i < 10; i++) {
		await log.emitEvent({ kind: i % 2 === 0 ? "even" : "odd", payload: i });
	}
	const sub = log.subscribe({ filter: (ev: EventRow) => ev.kind === "even" });
	const inflight = Promise.all(
		Array.from({ length: 10 }, (_, i) =>
			log.emitEvent({ kind: i % 2 === 0 ? "even" : "odd", payload: 10 + i }),
		),
	);

	const seen: EventRow[] = [];
	for await (const row of sub) {
		seen.push(row);
		if (row.seq === 19) break; // seq 19 is the last "even" emit (payload index 18)
	}
	sub.close();
	await inflight;

	expect(seen.every((r) => r.kind === "even")).toBe(true);
	expect(seen.map((r) => r.seq)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);
});

test("slow subscriber with >1024 backlog drops oldest and counts drops; DB keeps everything", async () => {
	const { handle, log } = freshLog();

	// Start the tail past its (empty) history replay so subsequent publishes
	// hit the bounded buffer rather than the replay path.
	const sub = log.subscribe();
	const it = sub[Symbol.asyncIterator]();
	const first = it.next();
	await log.emitEvent({ kind: "first", payload: null });
	expect((await first).value?.seq).toBe(1);

	// 1124 more events while the consumer stalls: buffer cap 1024 → the 100
	// oldest (seqs 2..101) are dropped, seqs 102..1125 remain buffered.
	for (let i = 0; i < 1124; i++) await log.emitEvent({ kind: "burst", payload: i });
	expect(sub.dropped()).toBe(100);

	const seen: number[] = [];
	for (let i = 0; i < 1024; i++) {
		const next = await it.next();
		if (next.done) break;
		seen.push(next.value.seq);
	}
	expect(seen).toEqual(range(102, 1125));

	sub.close();
	expect((await it.next()).done).toBe(true);

	// Drops are a subscriber-side concern only — the log itself is complete.
	expect(persistedSeqs(handle)).toEqual(range(1, 1125));
});

test("restart: re-opened DB continues seq from max(seq), no reuse", async () => {
	const { handle, log, dir } = freshLog();
	for (let i = 0; i < 5; i++) await log.emitEvent({ kind: "before", payload: i });
	handle.sqlite.close();

	// New process, same file: a fresh EventLog must pick up where max(seq)
	// left off because seq allocation reads the DB, not a JS counter.
	const reopened = openDatabase(join(dir, "events.db"));
	handles.push(reopened);
	const log2 = new EventLog(reopened);
	const row = await log2.emitEvent({ kind: "after", payload: null });

	expect(row.seq).toBe(6);
	expect(persistedSeqs(reopened)).toEqual(range(1, 6));
});
