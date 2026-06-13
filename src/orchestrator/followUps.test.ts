/**
 * Self-filing follow-up tasks tests.
 *
 *   parseFollowUps: array + {followUps} shapes, bad JSON/shape → [], title rules, cap.
 *   readFollowUpsFile: missing file → [].
 *   fileFollowUps: creates one draft task per entry linked to the parent,
 *     emits a followups.filed event, and is a no-op with no file.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects, tasks, events } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import {
	FOLLOW_UPS_REL_PATH,
	MAX_FOLLOW_UPS,
	fileFollowUps,
	parseFollowUps,
	readFollowUpsFile,
} from "./followUps.ts";

// ---------------------------------------------------------------------------
// parseFollowUps (pure)

test("parseFollowUps accepts a bare array of {title}", () => {
	const out = parseFollowUps(JSON.stringify([{ title: "fix broken link", description: "in README" }]));
	expect(out).toEqual([{ title: "fix broken link", description: "in README" }]);
});

test("parseFollowUps accepts {followUps:[...]} wrapper", () => {
	const out = parseFollowUps(JSON.stringify({ followUps: [{ title: "stale command" }] }));
	expect(out).toEqual([{ title: "stale command" }]);
});

test("parseFollowUps returns [] on bad JSON, wrong shape, or no valid entries", () => {
	expect(parseFollowUps("not json")).toEqual([]);
	expect(parseFollowUps(JSON.stringify({ nope: 1 }))).toEqual([]);
	expect(parseFollowUps(JSON.stringify([{ description: "no title" }, 42, null, { title: "" }]))).toEqual([]);
});

test("parseFollowUps trims, caps title length, and drops blank descriptions", () => {
	const out = parseFollowUps(JSON.stringify([{ title: `  ${"x".repeat(300)}  `, description: "   " }]));
	expect(out).toHaveLength(1);
	expect(out[0]!.title).toHaveLength(200);
	expect(out[0]!.description).toBeUndefined();
});

test("parseFollowUps caps the number of entries at MAX_FOLLOW_UPS", () => {
	const many = Array.from({ length: MAX_FOLLOW_UPS + 5 }, (_, i) => ({ title: `t${i}` }));
	expect(parseFollowUps(JSON.stringify(many))).toHaveLength(MAX_FOLLOW_UPS);
});

// ---------------------------------------------------------------------------
// readFollowUpsFile + fileFollowUps (DB)

let tmp: string;
let handle: DbHandle;
let log: EventLog;
let projectId: number;
let parentTaskId: number;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "ns-followups-"));
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
	const now = new Date().toISOString();
	projectId = handle.db
		.insert(projects)
		.values({ name: "p", repoUrl: "https://example.test/r.git", createdAt: now, updatedAt: now })
		.returning()
		.get().id;
	parentTaskId = handle.db
		.insert(tasks)
		.values({ projectId, title: "parent", state: "coding", createdAt: now, updatedAt: now })
		.returning()
		.get().id;
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function writeFollowUps(worktree: string, content: string): void {
	mkdirSync(join(worktree, ".nightshift"), { recursive: true });
	writeFileSync(join(worktree, FOLLOW_UPS_REL_PATH), content);
}

test("readFollowUpsFile returns [] when the file is absent", () => {
	expect(readFollowUpsFile(tmp)).toEqual([]);
});

test("fileFollowUps creates one draft task per entry linked to the parent", async () => {
	writeFollowUps(
		tmp,
		JSON.stringify([
			{ title: "fix broken link", description: "README points to a 404" },
			{ title: "remove stale command" },
		]),
	);

	const created = await fileFollowUps(handle, log, { projectId, parentTaskId, worktreePath: tmp });

	expect(created).toHaveLength(2);
	for (const row of created) {
		expect(row.state).toBe("draft");
		expect(row.projectId).toBe(projectId);
		expect(row.description).toContain(`task #${parentTaskId}`);
	}
	expect(created[0]!.title).toBe("fix broken link");

	// An audit event must be emitted with the count.
	const evs = handle.db.select().from(events).where(eq(events.kind, "followups.filed")).all();
	expect(evs).toHaveLength(1);
	expect(JSON.parse(evs[0]!.payloadJson!)).toMatchObject({ parentTaskId, count: 2 });
});

test("fileFollowUps is a silent no-op with no file and emits no event", async () => {
	const created = await fileFollowUps(handle, log, { projectId, parentTaskId, worktreePath: tmp });
	expect(created).toEqual([]);
	const evs = handle.db.select().from(events).where(eq(events.kind, "followups.filed")).all();
	expect(evs).toHaveLength(0);
});
