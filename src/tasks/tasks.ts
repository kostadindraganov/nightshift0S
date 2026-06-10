/**
 * Task CRUD service (task 1.5) — ported from the localforge feature service
 * (`ui-reference/features.ts`): plain functions over the DB handle, no HTTP
 * objects in here; the route handlers in `src/server/routes.ts` are thin
 * wrappers.
 *
 * Boundaries enforced here:
 *   - `updateTask` can NEVER change `state` — all state changes go through
 *     `transitionTask` (./transitions.ts) so the state machine + event-log
 *     invariants hold.
 *   - `deleteTask` only removes parked tasks (draft/backlog/cancelled/done);
 *     mid-flight states are rejected so a live run never loses its row.
 *   - Input fields are typed `unknown` and validated at runtime (localforge
 *     pattern) so raw JSON bodies can be passed straight through.
 *
 * Minimal project create/list also live here — just enough surface for tasks
 * to have a parent (the full project service is a later phase).
 */

import { and, eq, type SQL } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import {
	RISK_TIERS,
	TASK_CATEGORIES,
	TASK_STATES,
	type RiskTier,
	type TaskCategory,
	type TaskState,
} from "../db/columns.ts";
import { projects, tasks, type ProjectRow, type TaskRow } from "../db/schema.ts";
import { enqueueWrite } from "../db/writer.ts";

/** Maximum allowed length for a task title (matches UI maxLength — localforge). */
export const MAX_TITLE_LENGTH = 200;
/** Maximum allowed length for description / acceptance criteria. */
export const MAX_TEXT_LENGTH = 5000;

/** States a task may be created in: planner output starts in draft; manual entry may go straight to backlog. */
export const CREATABLE_STATES = ["draft", "backlog"] as const satisfies readonly TaskState[];

/** States a task may be deleted from — parked states only, never mid-flight. */
export const DELETABLE_STATES = [
	"draft",
	"backlog",
	"cancelled",
	"done",
] as const satisfies readonly TaskState[];

/**
 * Validation failure carrying its HTTP status (FeatureValidationError
 * pattern). 400 by default; 404 for missing referents, 409 for conflicts.
 */
export class ValidationError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.name = "ValidationError";
		this.status = status;
	}
}

// ---------------------------------------------------------------------------
// Field validators (localforge ports — accept unknown, return narrowed value)

function validateTitle(rawTitle: unknown): string {
	if (typeof rawTitle !== "string") throw new ValidationError("Title is required");
	const trimmed = rawTitle.trim();
	if (trimmed.length === 0) throw new ValidationError("Title is required");
	if (trimmed.length > MAX_TITLE_LENGTH) {
		throw new ValidationError(`Title must be ${MAX_TITLE_LENGTH} characters or fewer`);
	}
	return trimmed;
}

function normaliseText(raw: unknown, field: string): string | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== "string") throw new ValidationError(`${field} must be a string`);
	if (raw.length > MAX_TEXT_LENGTH) {
		throw new ValidationError(`${field} must be ${MAX_TEXT_LENGTH} characters or fewer`);
	}
	return raw;
}

function assertOneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
	field: string,
): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new ValidationError(
			`Invalid ${field} '${String(value)}'. Expected one of: ${allowed.join(", ")}`,
		);
	}
	return value as T;
}

function assertPriority(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new ValidationError("Priority must be an integer");
	}
	return value;
}

/** Validate that a string names a task state. Used by routes for `to`/`expected_from`/filters. */
export function assertTaskState(value: unknown, field: string): TaskState {
	const state = assertOneOf(value, TASK_STATES, field);
	if (state === undefined) throw new ValidationError(`${field} is required`);
	return state;
}

function ensureProjectExists(handle: DbHandle, projectId: number): void {
	const exists = handle.db
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.id, projectId))
		.get();
	if (!exists) throw new ValidationError(`Project ${projectId} not found`, 404);
}

// ---------------------------------------------------------------------------
// Projects (minimal — enough surface for tasks to have a parent)

export interface CreateProjectInput {
	name: unknown;
	repoUrl: unknown;
	defaultBranch?: unknown;
}

export function createProject(handle: DbHandle, input: CreateProjectInput): Promise<ProjectRow> {
	if (typeof input.name !== "string" || input.name.trim().length === 0) {
		throw new ValidationError("Project name is required");
	}
	if (typeof input.repoUrl !== "string" || input.repoUrl.trim().length === 0) {
		throw new ValidationError("Project repo_url is required");
	}
	if (input.defaultBranch !== undefined && typeof input.defaultBranch !== "string") {
		throw new ValidationError("default_branch must be a string");
	}
	const name = input.name.trim();
	const repoUrl = input.repoUrl.trim();
	const defaultBranch = input.defaultBranch;
	return enqueueWrite(() => {
		const now = new Date().toISOString();
		return handle.db
			.insert(projects)
			.values({
				name,
				repoUrl,
				...(defaultBranch !== undefined ? { defaultBranch } : {}),
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get();
	});
}

export function listProjects(handle: DbHandle): ProjectRow[] {
	return handle.db.select().from(projects).all();
}

// ---------------------------------------------------------------------------
// Tasks

export interface CreateTaskInput {
	projectId: number;
	title: unknown;
	description?: unknown;
	acceptanceCriteria?: unknown;
	/** Only draft|backlog are creatable; everything else is reached via transitions. */
	state?: unknown;
	priority?: unknown;
	category?: unknown;
	riskTier?: unknown;
}

export interface UpdateTaskInput {
	title?: unknown;
	description?: unknown;
	acceptanceCriteria?: unknown;
	priority?: unknown;
	category?: unknown;
	riskTier?: unknown;
}

/** Next priority slot for a project — one higher than the current max (localforge). */
function nextPriorityForProject(handle: DbHandle, projectId: number): number {
	const rows = handle.db
		.select({ priority: tasks.priority })
		.from(tasks)
		.where(eq(tasks.projectId, projectId))
		.all();
	if (rows.length === 0) return 0;
	return Math.max(...rows.map((r) => r.priority)) + 1;
}

export function createTask(handle: DbHandle, input: CreateTaskInput): Promise<TaskRow> {
	if (typeof input.projectId !== "number" || !Number.isInteger(input.projectId)) {
		throw new ValidationError("project_id must be an integer");
	}
	ensureProjectExists(handle, input.projectId);

	const title = validateTitle(input.title);
	const description = normaliseText(input.description ?? null, "Description");
	const acceptanceCriteria = normaliseText(input.acceptanceCriteria ?? null, "Acceptance criteria");
	const state: TaskState = assertOneOf(input.state, CREATABLE_STATES, "state") ?? "draft";
	const category: TaskCategory =
		assertOneOf(input.category, TASK_CATEGORIES, "category") ?? "functional";
	const riskTier: RiskTier = assertOneOf(input.riskTier, RISK_TIERS, "risk_tier") ?? "full";
	const priority = assertPriority(input.priority);
	const projectId = input.projectId;

	return enqueueWrite(() => {
		const now = new Date().toISOString();
		return handle.db
			.insert(tasks)
			.values({
				projectId,
				title,
				description,
				acceptanceCriteria,
				state,
				priority: priority ?? nextPriorityForProject(handle, projectId),
				category,
				riskTier,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get();
	});
}

export function getTask(handle: DbHandle, id: number): TaskRow | null {
	return handle.db.select().from(tasks).where(eq(tasks.id, id)).get() ?? null;
}

export interface ListTasksFilter {
	projectId?: number;
	state?: TaskState;
}

/** List tasks, optionally filtered by project and/or state, ordered by priority then id. */
export function listTasks(handle: DbHandle, filter: ListTasksFilter = {}): TaskRow[] {
	const clauses: SQL[] = [];
	if (filter.projectId !== undefined) clauses.push(eq(tasks.projectId, filter.projectId));
	if (filter.state !== undefined) clauses.push(eq(tasks.state, filter.state));
	const query = handle.db.select().from(tasks);
	const rows = (clauses.length > 0 ? query.where(and(...clauses)) : query).all();
	return rows.sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.id - b.id));
}

/**
 * Update content/priority fields only. `state` is deliberately NOT accepted —
 * state changes must go through `transitionTask` so the state machine and the
 * event-log invariant hold. Returns null when the task doesn't exist.
 */
export function updateTask(
	handle: DbHandle,
	id: number,
	input: UpdateTaskInput,
): Promise<TaskRow | null> {
	const patch: Partial<typeof tasks.$inferInsert> = {};
	if (input.title !== undefined) patch.title = validateTitle(input.title);
	if (input.description !== undefined) {
		patch.description = normaliseText(input.description, "Description");
	}
	if (input.acceptanceCriteria !== undefined) {
		patch.acceptanceCriteria = normaliseText(input.acceptanceCriteria, "Acceptance criteria");
	}
	const category = assertOneOf(input.category, TASK_CATEGORIES, "category");
	if (category !== undefined) patch.category = category;
	const riskTier = assertOneOf(input.riskTier, RISK_TIERS, "risk_tier");
	if (riskTier !== undefined) patch.riskTier = riskTier;
	const priority = assertPriority(input.priority);
	if (priority !== undefined) patch.priority = priority;

	return enqueueWrite(() => {
		patch.updatedAt = new Date().toISOString();
		return (
			handle.db.update(tasks).set(patch).where(eq(tasks.id, id)).returning().get() ?? null
		);
	});
}

/**
 * Delete a task. Allowed only in parked states (DELETABLE_STATES); deleting a
 * mid-flight task (ready/coding/review/approved/merging/needs_human/failed)
 * is a 409 — cancel it first. Returns false when the task doesn't exist.
 */
export function deleteTask(handle: DbHandle, id: number): Promise<boolean> {
	return enqueueWrite(() => {
		const existing = handle.db.select().from(tasks).where(eq(tasks.id, id)).get();
		if (!existing) return false;
		if (!(DELETABLE_STATES as readonly TaskState[]).includes(existing.state)) {
			throw new ValidationError(
				`Cannot delete task ${id} in state '${existing.state}'. Deletable states: ${DELETABLE_STATES.join(", ")}`,
				409,
			);
		}
		handle.db.delete(tasks).where(eq(tasks.id, id)).run();
		return true;
	});
}
