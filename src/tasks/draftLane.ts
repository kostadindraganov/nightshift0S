/**
 * WHY: Draft Lane (§3.10 item 2) — the "To-Do" staging area before backlog.
 * Provides two operations on top of the existing state machine:
 *
 *   1. promoteDraft — moves draft→backlog (the "promote" edge already in
 *      TASK_TRANSITIONS), with an optional pre-promotion planner expand step
 *      that fills in description + acceptance criteria before the transition.
 *      The planner is injectable so this module runs on macOS with a fake.
 *
 *   2. importMarkdownDrafts — parses a bullet-list string into draft TaskRows.
 *      Bullets become titles; an optional sub-bullet starting with "ac:" becomes
 *      acceptance_criteria. Fail-closed: malformed input is rejected, never
 *      silently trimmed into something unintended.
 *
 * Planner contract: promote's optional expand step needs a PlannerFn —
 *   (title: string, description?: string) => Promise<PlannerResult>
 * (see the type below). The src/planner module's planToTasks has a different
 * shape (it bulk-creates a whole backlog from a free-text plan), so the wiring
 * layer (routes.ts / server main) must adapt a planner into a PlannerFn before
 * passing it as deps.planner. No planner is registered server-side yet.
 */

import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import { tasks, type TaskRow } from "../db/schema.ts";
import { createTask, updateTask, ValidationError, MAX_TITLE_LENGTH, MAX_TEXT_LENGTH } from "./tasks.ts";
import { transitionTask } from "./transitions.ts";

// ---------------------------------------------------------------------------
// Planner contract — injectable so this module never hard-imports the planner.

/**
 * The result shape the planner must return.
 * description + acceptanceCriteria fill the task before promote.
 */
export interface PlannerResult {
	description: string;
	acceptanceCriteria: string;
}

/**
 * Injectable planner function used by promote's optional expand step. The
 * wiring layer adapts a concrete planner (e.g. an LLM-backed expander) into
 * this shape; src/planner/planner.ts#planToTasks is a different, backlog-wide
 * operation and is not directly assignable here.
 */
export type PlannerFn = (title: string, description?: string) => Promise<PlannerResult>;

// ---------------------------------------------------------------------------
// DraftLaneDeps — all side-effecting dependencies are injectable.

export interface DraftLaneDeps {
	handle: DbHandle;
	log: EventLog;
	/** Optional: when provided, promote will call it to expand draft before transition. */
	planner?: PlannerFn;
}

// ---------------------------------------------------------------------------
// promoteDraft

export type PromoteResult =
	| { ok: true; task: TaskRow; expanded: boolean }
	| { ok: false; reason: "not_found" | "not_draft" | "planner_error" | "lost_race"; message: string };

/**
 * Promote a draft task to backlog.
 * When deps.planner is provided, calls it first to fill description +
 * acceptanceCriteria (if not already set on the task). Never silently swallows
 * a planner failure — returns {ok:false, reason:"planner_error"} so the caller
 * can decide whether to retry or surface the error to the user.
 */
export async function promoteDraft(
	deps: DraftLaneDeps,
	taskId: number,
	actor: string,
): Promise<PromoteResult> {
	const { handle, log, planner } = deps;

	const task = handle.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
	if (!task) return { ok: false, reason: "not_found", message: `task ${taskId} not found` };
	if (task.state !== "draft") {
		return {
			ok: false,
			reason: "not_draft",
			message: `task ${taskId} is in state '${task.state}', not 'draft'`,
		};
	}

	// Optional planner expansion — fills description + AC when absent.
	let expanded = false;
	if (planner) {
		let planResult: PlannerResult;
		try {
			planResult = await planner(task.title, task.description ?? undefined);
		} catch (err) {
			return {
				ok: false,
				reason: "planner_error",
				message: err instanceof Error ? err.message : "planner failed",
			};
		}
		const needsDesc = !task.description && planResult.description;
		const needsAc = !task.acceptanceCriteria && planResult.acceptanceCriteria;
		if (needsDesc || needsAc) {
			await updateTask(handle, taskId, {
				...(needsDesc ? { description: planResult.description } : {}),
				...(needsAc ? { acceptanceCriteria: planResult.acceptanceCriteria } : {}),
			});
			expanded = true;
		}
	}

	// draft → backlog via the state machine (guarded on expectedFrom).
	const result = await transitionTask(handle, log, {
		taskId,
		to: "backlog",
		expectedFrom: "draft",
		actor,
	});

	if (!result.ok) {
		return {
			ok: false,
			reason: result.reason === "not_found" ? "not_found" : "lost_race",
			message: result.reason === "not_found"
				? `task ${taskId} not found`
				: `task ${taskId} was moved by a concurrent actor`,
		};
	}

	return { ok: true, task: result.task, expanded };
}

// ---------------------------------------------------------------------------
// parseMarkdownDrafts + importMarkdownDrafts

export interface ImportedDraft {
	title: string;
	acceptanceCriteria: string | null;
}

/**
 * Parse a markdown bullet list into draft task descriptors.
 * Supported format:
 *   - Task title
 *     - ac: acceptance criteria text
 *   - Another task
 *
 * Rules (fail-closed):
 *   - Only lines starting with "- " are treated as top-level tasks.
 *   - A sub-bullet "  - ac: <text>" (2+ spaces) sets acceptanceCriteria.
 *   - Empty titles or any field exceeding DB limits → ValidationError.
 *   - Empty input → empty array (not an error).
 *   - Throws ValidationError for any bad entry — never silently drops a bullet.
 */
export function parseMarkdownDrafts(markdown: string): ImportedDraft[] {
	if (typeof markdown !== "string") throw new ValidationError("markdown must be a string");
	const lines = markdown.split("\n");
	const drafts: ImportedDraft[] = [];
	let current: ImportedDraft | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		// Match "- " followed by anything (including just whitespace) so we can
		// reject empty/blank titles explicitly rather than silently ignoring the line.
		const topBullet = line.match(/^- (.*)$/);
		if (topBullet) {
			if (current) drafts.push(current);
			const title = topBullet[1]!.trim();
			if (title.length === 0) throw new ValidationError(`Line ${i + 1}: empty task title`);
			if (title.length > MAX_TITLE_LENGTH) {
				throw new ValidationError(`Line ${i + 1}: title exceeds ${MAX_TITLE_LENGTH} characters`);
			}
			current = { title, acceptanceCriteria: null };
			continue;
		}

		// Sub-bullet for acceptance criteria (2+ leading spaces before "- ac: ...")
		const acBullet = line.match(/^\s{2,}- ac: (.+)$/);
		if (acBullet && current) {
			const ac = acBullet[1]!.trim();
			if (ac.length > MAX_TEXT_LENGTH) {
				throw new ValidationError(`Line ${i + 1}: acceptance criteria exceeds ${MAX_TEXT_LENGTH} characters`);
			}
			current.acceptanceCriteria = ac;
		}
	}
	if (current) drafts.push(current);
	return drafts;
}

/**
 * Parse a markdown bullet list and bulk-insert draft tasks into the DB.
 * Parse is done before any DB writes (fail-closed: parse errors abort before
 * touching the DB). Returns the created TaskRows in insertion order.
 */
export async function importMarkdownDrafts(
	deps: Pick<DraftLaneDeps, "handle">,
	projectId: number,
	markdown: string,
): Promise<TaskRow[]> {
	const parsed = parseMarkdownDrafts(markdown); // throws on bad input, before any DB work
	if (parsed.length === 0) return [];
	return Promise.all(
		parsed.map((d) =>
			createTask(deps.handle, {
				projectId,
				title: d.title,
				acceptanceCriteria: d.acceptanceCriteria ?? null,
				state: "draft",
			}),
		),
	);
}
