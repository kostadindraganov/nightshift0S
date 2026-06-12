/**
 * draftLane tests — critical invariants only (owner instruction: <=6 cases).
 *
 *   1. parseMarkdownDrafts — round-trips a bullet list with AC sub-bullets.
 *   2. parseMarkdownDrafts — empty input returns [].
 *   3. parseMarkdownDrafts — empty title throws ValidationError (fail-closed).
 *   4. promoteDraft — non-draft task returns {ok:false, reason:'not_draft'}.
 *   5. promoteDraft — happy path: draft→backlog, returns {ok:true, expanded:false}.
 *   6. promoteDraft with planner — expands task then transitions to backlog.
 */

import { beforeEach, expect, test } from "bun:test";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects, tasks } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { ValidationError } from "./tasks.ts";
import {
	parseMarkdownDrafts,
	promoteDraft,
	type DraftLaneDeps,
	type PlannerResult,
} from "./draftLane.ts";

let handle: DbHandle;
let log: EventLog;
let projectId: number;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
	const now = new Date().toISOString();
	projectId = handle.db
		.insert(projects)
		.values({ name: "p", repoUrl: "https://example.test/r.git", createdAt: now, updatedAt: now })
		.returning()
		.get().id;
});

function insertTask(state: string, title = "A task") {
	const now = new Date().toISOString();
	return handle.db
		.insert(tasks)
		.values({
			projectId,
			title,
			description: null,
			acceptanceCriteria: null,
			state: state as "draft",
			priority: 0,
			category: "functional",
			riskTier: "full",
			createdAt: now,
			updatedAt: now,
		})
		.returning()
		.get();
}

// 1. round-trip a bullet list with AC sub-bullets
test("parseMarkdownDrafts — parses titles and AC sub-bullets", () => {
	const md = [
		"- First task",
		"  - ac: Must pass linting",
		"- Second task",
	].join("\n");
	const result = parseMarkdownDrafts(md);
	expect(result).toHaveLength(2);
	expect(result[0]).toEqual({ title: "First task", acceptanceCriteria: "Must pass linting" });
	expect(result[1]).toEqual({ title: "Second task", acceptanceCriteria: null });
});

// 2. empty input → []
test("parseMarkdownDrafts — empty string returns empty array", () => {
	expect(parseMarkdownDrafts("")).toHaveLength(0);
	expect(parseMarkdownDrafts("   \n\n")).toHaveLength(0);
});

// 3. empty title → ValidationError (fail-closed)
test("parseMarkdownDrafts — empty title throws ValidationError", () => {
	expect(() => parseMarkdownDrafts("- ")).toThrow(ValidationError);
});

// 4. non-draft task → not_draft
test("promoteDraft — returns not_draft for a backlog task", async () => {
	const task = insertTask("backlog");
	const deps: DraftLaneDeps = { handle, log };
	const result = await promoteDraft(deps, task.id, "test");
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe("not_draft");
});

// 5. happy path draft → backlog
test("promoteDraft — transitions draft to backlog", async () => {
	const task = insertTask("draft");
	const deps: DraftLaneDeps = { handle, log };
	const result = await promoteDraft(deps, task.id, "test");
	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.task.state).toBe("backlog");
		expect(result.expanded).toBe(false);
	}
});

// 6. planner expansion fills description + AC before transition
test("promoteDraft with planner — expands and transitions", async () => {
	const task = insertTask("draft", "Implement login");
	const fakePlanner = async (_title: string): Promise<PlannerResult> => ({
		description: "OAuth2 flow",
		acceptanceCriteria: "User can log in with Google",
	});
	const deps: DraftLaneDeps = { handle, log, planner: fakePlanner };
	const result = await promoteDraft(deps, task.id, "test");
	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.task.state).toBe("backlog");
		expect(result.expanded).toBe(true);
		// Verify the DB row was patched before transition
		const { eq } = await import("drizzle-orm");
		const row = handle.db.select().from(tasks).where(eq(tasks.id, task.id)).get();
		expect(row?.description).toBe("OAuth2 flow");
		expect(row?.acceptanceCriteria).toBe("User can log in with Google");
	}
});
