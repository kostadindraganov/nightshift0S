/**
 * WHY: The PLANNER (task 4.1, BLUEPRINT §3, build step 4) — turns a free-text
 * plan into BACKLOG tasks with description + spec-first acceptance criteria
 * (§3.5: testable assertions) and dependency edges, reusing the cycle-checked
 * insert from ../tasks/dependencies.ts.
 *
 * The LLM is an INJECTED structured-output client (returns raw stdout) so this
 * module runs on macOS with a scripted fake — same injectable-deps shape as
 * src/orchestrator/coder.ts and src/runs/spawn.ts. The ONLY path from stdout to
 * data is schemaRepair.extractStructured (BLUEPRINT §3.12.13), which is
 * FAIL-CLOSED: a malformed response throws PlannerError and NOTHING is
 * persisted — no partial garbage.
 *
 * Fail-closed ordering: parse → validate shape → in-memory cycle check over the
 * declared edges → only then persist tasks, then add dependencies. A cyclic
 * plan is rejected before the first INSERT, so the DB is never left half-built.
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { TaskRow } from "../db/schema.ts";
import { createTask } from "../tasks/tasks.ts";
import { addDependency } from "../tasks/dependencies.ts";
import { extractStructured } from "../providers/schemaRepair.ts";

// ---------------------------------------------------------------------------
// Injected LLM client
// ---------------------------------------------------------------------------

/**
 * Structured-output client: given the plan text, returns the agent's raw
 * stdout. The plan JSON is expected wrapped in a `<plan>…</plan>` tag block,
 * extracted via schemaRepair (fail-closed). A scripted fake satisfies this.
 */
export interface PlannerLLM {
	plan(planText: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlanToTasksInput {
	projectId: number;
	planText: string;
}

/** A planned task with description, testable acceptance criteria, and ref deps. */
interface PlannedTask {
	ref: string;
	title: string;
	description: string;
	acceptanceCriteria: string[];
	dependsOn: string[];
}

export interface PlanToTasksResult {
	/** Created task rows, in plan order. */
	tasks: TaskRow[];
	/** taskId → the refs it now depends on (already persisted). */
	dependencies: Array<{ taskId: number; dependsOnTaskId: number }>;
}

/** Thrown when the LLM output cannot be turned into a clean backlog. */
export class PlannerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlannerError";
	}
}

// ---------------------------------------------------------------------------
// Validation (fail-closed; no DB writes until the whole plan is proven sound)
// ---------------------------------------------------------------------------

function asNonEmptyString(value: unknown, what: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new PlannerError(`${what} must be a non-empty string`);
	}
	return value.trim();
}

/** Narrow the schemaRepair `unknown` into a validated, cycle-free plan. */
function validatePlan(value: unknown): PlannedTask[] {
	if (typeof value !== "object" || value === null || !Array.isArray((value as { tasks?: unknown }).tasks)) {
		throw new PlannerError("plan must be an object with a `tasks` array");
	}
	const rawTasks = (value as { tasks: unknown[] }).tasks;
	if (rawTasks.length === 0) {
		throw new PlannerError("plan contains no tasks");
	}

	const refs = new Set<string>();
	const planned: PlannedTask[] = [];
	for (const raw of rawTasks) {
		if (typeof raw !== "object" || raw === null) {
			throw new PlannerError("each task must be an object");
		}
		const t = raw as Record<string, unknown>;
		const ref = asNonEmptyString(t.ref, "task.ref");
		if (refs.has(ref)) throw new PlannerError(`duplicate task ref '${ref}'`);
		refs.add(ref);

		const title = asNonEmptyString(t.title, "task.title");
		const description = asNonEmptyString(t.description, `task '${ref}' description`);

		if (!Array.isArray(t.acceptanceCriteria) || t.acceptanceCriteria.length === 0) {
			throw new PlannerError(`task '${ref}' needs at least one acceptance criterion (§3.5)`);
		}
		const acceptanceCriteria = t.acceptanceCriteria.map((c) =>
			asNonEmptyString(c, `task '${ref}' acceptance criterion`),
		);

		const dependsOnRaw = t.dependsOn ?? [];
		if (!Array.isArray(dependsOnRaw)) {
			throw new PlannerError(`task '${ref}' dependsOn must be an array`);
		}
		const dependsOn = dependsOnRaw.map((d) => asNonEmptyString(d, `task '${ref}' dependsOn entry`));

		planned.push({ ref, title, description, acceptanceCriteria, dependsOn });
	}

	// Every dependency must name a known ref, and no self-loop.
	for (const t of planned) {
		for (const dep of t.dependsOn) {
			if (dep === t.ref) throw new PlannerError(`task '${t.ref}' depends on itself`);
			if (!refs.has(dep)) {
				throw new PlannerError(`task '${t.ref}' depends on unknown ref '${dep}'`);
			}
		}
	}

	assertNoCycle(planned);
	return planned;
}

/**
 * In-memory cycle check over the declared edges (ref → dependsOn). The DB-level
 * `addDependency` re-checks per edge, but we reject the WHOLE plan here first so
 * a cyclic plan never causes a partial insert (fail-closed). DFS with a
 * recursion stack — the plan graph is tiny.
 */
function assertNoCycle(planned: PlannedTask[]): void {
	const edges = new Map<string, string[]>(planned.map((t) => [t.ref, t.dependsOn]));
	const VISITING = 1;
	const DONE = 2;
	const marks = new Map<string, number>();

	const visit = (ref: string): void => {
		const mark = marks.get(ref);
		if (mark === DONE) return;
		if (mark === VISITING) {
			throw new PlannerError(`plan dependency graph has a cycle (at '${ref}')`);
		}
		marks.set(ref, VISITING);
		for (const dep of edges.get(ref) ?? []) visit(dep);
		marks.set(ref, DONE);
	};

	for (const t of planned) visit(t.ref);
}

// ---------------------------------------------------------------------------
// planToTasks
// ---------------------------------------------------------------------------

/**
 * Turn a free-text plan into BACKLOG tasks + dependency edges.
 *
 * Flow (fail-closed): call the injected LLM → extractStructured(<plan>) →
 * validatePlan (shape + refs + in-memory cycle check) → persist every task in
 * `backlog` (description + acceptance criteria joined as testable assertions) →
 * wire dependencies via the cycle-checked `addDependency`. Any failure before
 * persistence throws PlannerError with nothing written.
 */
export async function planToTasks(
	deps: { handle: DbHandle; log: EventLog; llm: PlannerLLM },
	input: PlanToTasksInput,
): Promise<PlanToTasksResult> {
	const { handle } = deps;

	const stdout = await deps.llm.plan(input.planText);
	const extracted = extractStructured(stdout, { tag: "plan" });
	if (!extracted.ok) {
		throw new PlannerError(`planner output not extractable: ${extracted.reason}`);
	}

	// Validate the ENTIRE plan (incl. cycle check) before any DB write.
	const planned = validatePlan(extracted.value);

	// Persist tasks in backlog. Acceptance criteria are stored as a newline
	// bullet list of testable assertions (§3.5).
	const refToId = new Map<string, number>();
	const tasks: TaskRow[] = [];
	for (const t of planned) {
		const row = await createTask(handle, {
			projectId: input.projectId,
			title: t.title,
			description: t.description,
			acceptanceCriteria: t.acceptanceCriteria.map((c) => `- ${c}`).join("\n"),
			state: "backlog",
		});
		refToId.set(t.ref, row.id);
		tasks.push(row);
	}

	// Wire dependencies through the cycle-checked insert. The plan was already
	// proven acyclic in memory, so addDependency never rejects here.
	const dependencies: Array<{ taskId: number; dependsOnTaskId: number }> = [];
	for (const t of planned) {
		const taskId = refToId.get(t.ref) as number;
		for (const dep of t.dependsOn) {
			const dependsOnTaskId = refToId.get(dep) as number;
			await addDependency(handle, taskId, dependsOnTaskId);
			dependencies.push({ taskId, dependsOnTaskId });
		}
	}

	return { tasks, dependencies };
}
