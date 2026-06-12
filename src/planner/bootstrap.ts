/**
 * WHY: Turns a freeform project description into a backlog of draft tasks by
 * calling an injected planner (LLM). This is the nightshift equivalent of the
 * localforge bootstrap pattern (reference/warren/scheduler.ts): all
 * side-effecting deps (the planner LLM call, task creation) are injectable so
 * the module runs in tests with fakes — no live provider needed.
 *
 * Fail-closed: if the planner output cannot be parsed as a valid task list,
 * bootstrapProject returns ok:false and creates nothing — it never fabricates
 * tasks or silently falls back to an empty list.
 */

import type { DbHandle } from "../db/client.ts";
import { createTask } from "../tasks/tasks.ts";
import { extractStructured } from "../providers/schemaRepair.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One task item emitted by the planner. */
export interface PlannerTaskItem {
	title: string;
	description?: string;
	acceptance_criteria?: string;
}

/**
 * Injectable planner seam. Receives a prompt and returns raw stdout.
 * In production this wraps ProviderDriver.runOnce; in tests it is a plain fake.
 */
export interface Planner {
	runOnce(input: { prompt: string }): Promise<{ stdout: string }>;
}

export interface BootstrapDeps {
	handle: DbHandle;
	planner: Planner;
}

export interface BootstrapInput {
	projectId: number;
	description: string;
}

export type BootstrapResult =
	| { ok: true; tasks: Array<{ id: number; title: string }> }
	| { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_PREFIX = `You are a project planner. Given a project description, produce a backlog of development tasks.

Rules:
- Output ONLY a JSON array wrapped in <output>...</output> tags. No prose before or after the tags.
- Each element must have "title" (required, <=200 chars) and optionally "description" and "acceptance_criteria" (strings).
- Minimum 1 task, maximum 50 tasks.
- Tasks should be concrete and independently executable.

Example:
<output>
[
  {"title": "Set up project scaffold", "description": "Init repo + CI", "acceptance_criteria": "CI passes on empty repo"},
  {"title": "Add user authentication", "description": "JWT-based login"}
]
</output>

Project description:
`;

function buildPrompt(description: string): string {
	return SYSTEM_PROMPT_PREFIX + description;
}

// ---------------------------------------------------------------------------
// Response parser — fail-closed
// ---------------------------------------------------------------------------

function parseTaskList(stdout: string): PlannerTaskItem[] | null {
	const extracted = extractStructured(stdout, { tag: "output" });
	if (!extracted.ok) return null;

	const raw = extracted.value;
	if (!Array.isArray(raw) || raw.length === 0) return null;

	const items: PlannerTaskItem[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) return null;
		const e = entry as Record<string, unknown>;
		if (typeof e.title !== "string" || e.title.trim().length === 0) return null;
		const item: PlannerTaskItem = { title: e.title.trim() };
		if (typeof e.description === "string") item.description = e.description;
		if (typeof e.acceptance_criteria === "string") item.acceptance_criteria = e.acceptance_criteria;
		items.push(item);
	}

	return items.length > 0 ? items : null;
}

// ---------------------------------------------------------------------------
// bootstrapProject
// ---------------------------------------------------------------------------

/**
 * Call the planner with a freeform project description, parse its response
 * into a task list, and bulk-insert the tasks as draft backlog entries.
 *
 * Fail-closed: returns ok:false (without touching the DB) if the planner
 * output cannot be parsed as a valid task list.
 */
export async function bootstrapProject(
	deps: BootstrapDeps,
	input: BootstrapInput,
): Promise<BootstrapResult> {
	const { handle, planner } = deps;
	const { projectId, description } = input;

	if (description.trim().length === 0) {
		return { ok: false, reason: "description must not be empty" };
	}

	// Call the planner.
	const { stdout } = await planner.runOnce({ prompt: buildPrompt(description) });

	// Parse — fail-closed: no tasks created on parse failure.
	const items = parseTaskList(stdout);
	if (items === null) {
		return { ok: false, reason: "planner output could not be parsed as a task list" };
	}

	// Create tasks.
	const created: Array<{ id: number; title: string }> = [];
	for (const item of items) {
		const task = await createTask(handle, {
			projectId,
			title: item.title,
			description: item.description ?? null,
			acceptanceCriteria: item.acceptance_criteria ?? null,
			state: "backlog",
		});
		created.push({ id: task.id, title: task.title });
	}

	return { ok: true, tasks: created };
}
