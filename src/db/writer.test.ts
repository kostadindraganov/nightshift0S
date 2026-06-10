/**
 * Parallel-write stress test for the serialized writer queue (task 1.1).
 *
 * Fires 200+ concurrent enqueueWrite inserts from multiple async contexts
 * against a temp FILE-backed DB (WAL, like production — not :memory:) and
 * asserts: every row landed, no SQLITE_BUSY surfaced, and writes were
 * strictly serialized (never more than one write fn in flight).
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { projects } from "./schema.ts";
import { enqueueWrite } from "./writer.ts";

const dir = mkdtempSync(join(tmpdir(), "nightshift-writer-"));
const handle = openDatabase(join(dir, "stress.db"));
runMigrations(handle);

afterAll(() => {
	handle.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const TOTAL = 250;
const now = new Date().toISOString();

test(`${TOTAL} concurrent enqueueWrite inserts land, serialized, without SQLITE_BUSY`, async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	const completionOrder: number[] = [];

	const writeOne = (i: number) =>
		enqueueWrite(async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			// Yield mid-write: if the queue interleaved, a second fn would
			// enter here and bump inFlight to 2.
			await Promise.resolve();
			handle.db
				.insert(projects)
				.values({ name: `p${i}`, repoUrl: `https://example.com/${i}.git`, createdAt: now, updatedAt: now })
				.run();
			completionOrder.push(i);
			inFlight--;
			return i;
		});

	// Three async contexts enqueue interleaved batches concurrently.
	const batch = (offset: number, count: number) =>
		Promise.all(Array.from({ length: count }, (_, i) => writeOne(offset + i)));
	const results = (
		await Promise.all([batch(0, 100), batch(100, 100), batch(200, TOTAL - 200)])
	).flat();

	// No write rejected (a surfaced SQLITE_BUSY would reject Promise.all).
	expect(results).toHaveLength(TOTAL);
	expect(new Set(results).size).toBe(TOTAL);

	// All rows landed.
	const rows = handle.db.select().from(projects).all();
	expect(rows).toHaveLength(TOTAL);

	// Strict serialization: never two write fns in flight at once, and every
	// write ran exactly once.
	expect(maxInFlight).toBe(1);
	expect(completionOrder).toHaveLength(TOTAL);
});

test("a rejected write surfaces to its caller but does not break the chain", async () => {
	const failing = enqueueWrite(() => {
		throw new Error("boom");
	});
	const following = enqueueWrite(() => 42);
	expect(failing).rejects.toThrow("boom");
	expect(await following).toBe(42);
});
