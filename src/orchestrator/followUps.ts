/**
 * Self-filing follow-up tasks — "the loop feeds itself" (loop-engineering).
 *
 * While a coder works it finds incidental, out-of-scope problems: a broken doc
 * link, a stale command, a small unrelated bug. Fixing them on the spot would
 * widen scope, so instead the agent writes them to `.nightshift/follow-ups.json`
 * in its worktree. On run success the scheduler reads that file and creates one
 * **draft** task per entry, linked to the parent.
 *
 * Why draft (never ready): nothing the agent files is actionable until the
 * manager/triage pass judges it — exactly the guardrail that keeps the loop from
 * widening its own permissions. Code problems become tickets become (after
 * human/triage promotion) pull requests, without anyone asking.
 *
 * The agent never touches the DB: it writes a file, the server parses and
 * validates it through `createTask`. That keeps a prompt-injectable agent from
 * minting arbitrary rows, and a hard cap bounds a runaway/abusive file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { TaskRow } from "../db/schema.ts";
import { createTask } from "../tasks/tasks.ts";

/** Worktree-relative path the agent writes follow-ups to. */
export const FOLLOW_UPS_REL_PATH = ".nightshift/follow-ups.json";

/** Upper bound on follow-ups filed per run — anti-spam / anti-injection. */
export const MAX_FOLLOW_UPS = 10;

export interface FollowUpSpec {
	title: string;
	description?: string;
}

export interface FileFollowUpsInput {
	projectId: number;
	parentTaskId: number;
	worktreePath: string;
}

/**
 * Parse + validate the follow-ups file content. Returns [] on any problem
 * (malformed JSON, wrong shape, no valid entries). Accepts either a bare array
 * or `{ "followUps": [...] }`. Each entry needs a non-empty string `title`;
 * everything else is ignored. Caps at MAX_FOLLOW_UPS.
 */
export function parseFollowUps(raw: string): FollowUpSpec[] {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return [];
	}

	const arr = Array.isArray(data)
		? data
		: Array.isArray((data as { followUps?: unknown })?.followUps)
			? (data as { followUps: unknown[] }).followUps
			: null;
	if (arr === null) return [];

	const out: FollowUpSpec[] = [];
	for (const item of arr) {
		if (out.length >= MAX_FOLLOW_UPS) break;
		if (typeof item !== "object" || item === null) continue;
		const rawTitle = (item as { title?: unknown }).title;
		if (typeof rawTitle !== "string" || rawTitle.trim() === "") continue;
		const spec: FollowUpSpec = { title: rawTitle.trim().slice(0, 200) };
		const desc = (item as { description?: unknown }).description;
		if (typeof desc === "string" && desc.trim() !== "") spec.description = desc.trim();
		out.push(spec);
	}
	return out;
}

/** Read + parse the follow-ups file from a worktree. Missing file → []. */
export function readFollowUpsFile(worktreePath: string): FollowUpSpec[] {
	const path = join(worktreePath, FOLLOW_UPS_REL_PATH);
	if (!existsSync(path)) return [];
	try {
		return parseFollowUps(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
}

/**
 * Read the agent-written follow-ups and create one draft task per entry, each
 * linked to the parent task. Returns the created rows (empty when there is
 * nothing to file). Emits one `followups.filed` audit event when any are made.
 */
export async function fileFollowUps(
	handle: DbHandle,
	log: EventLog,
	input: FileFollowUpsInput,
): Promise<TaskRow[]> {
	const specs = readFollowUpsFile(input.worktreePath);
	if (specs.length === 0) return [];

	const created: TaskRow[] = [];
	for (const spec of specs) {
		const description = [
			spec.description ?? "",
			"",
			`_Filed as a follow-up by an agent while working on task #${input.parentTaskId}._`,
		]
			.join("\n")
			.trim();
		// createTask validates project + title; a bad entry shouldn't sink the rest.
		try {
			const row = await createTask(handle, {
				projectId: input.projectId,
				title: spec.title,
				description,
				state: "draft",
			});
			created.push(row);
		} catch {
			continue;
		}
	}

	if (created.length > 0) {
		await log.emitEvent({
			taskId: input.parentTaskId,
			kind: "followups.filed",
			payload: { parentTaskId: input.parentTaskId, count: created.length, taskIds: created.map((t) => t.id) },
		});
	}

	return created;
}
