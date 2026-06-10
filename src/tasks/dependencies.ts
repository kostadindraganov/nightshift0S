/**
 * Task dependency edges + readiness recompute (task 1.5).
 *
 * `addDependency`/`removeDependency` are ports of the localforge feature
 * dependency helpers (`ui-reference/features.ts`): same-project check,
 * self-dep reject, duplicate reject (backed by the UNIQUE index), and the
 * BFS `wouldCreateCycle` walk over the forward dependency graph.
 *
 * `recomputeReadiness` is the canonical SPEC-STATE-MACHINES §6 "dependency
 * unblock" query: backlog tasks with NO dependency whose merge_sha is null
 * are promoted to ready. Promotions are guarded updates and each one emits a
 * `task.state_changed` event in the same writer link (invariant 5). It is
 * called after dependency changes here and (later phases) on merge events.
 */

import { and, eq, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbHandle } from "../db/client.ts";
import {
	taskDependencies,
	tasks,
	type TaskDependencyRow,
	type TaskRow,
} from "../db/schema.ts";
import { enqueueWrite } from "../db/writer.ts";
import type { EventLog } from "../events/events.ts";
import { TASK_STATE_CHANGED } from "./transitions.ts";
import { getTask, ValidationError } from "./tasks.ts";

/**
 * BFS over the forward dependency graph (localforge `wouldCreateCycle`): if
 * any path from `dependsOnTaskId` leads back to `taskId`, adding the edge
 * taskId→dependsOnTaskId would close a cycle.
 */
export function wouldCreateCycle(
	handle: DbHandle,
	taskId: number,
	dependsOnTaskId: number,
): boolean {
	const visited = new Set<number>();
	const queue: number[] = [dependsOnTaskId];
	while (queue.length > 0) {
		const current = queue.shift() as number;
		if (current === taskId) return true;
		if (visited.has(current)) continue;
		visited.add(current);
		const next = handle.db
			.select({ dependsOnTaskId: taskDependencies.dependsOnTaskId })
			.from(taskDependencies)
			.where(eq(taskDependencies.taskId, current))
			.all();
		for (const n of next) queue.push(n.dependsOnTaskId);
	}
	return false;
}

/**
 * Add a dependency: `taskId` will depend on `dependsOnTaskId`.
 * Rejects: missing tasks (404), self-dependency, cross-project edges,
 * duplicates (409), and cycles (direct or transitive).
 */
export function addDependency(
	handle: DbHandle,
	taskId: number,
	dependsOnTaskId: number,
): Promise<TaskDependencyRow> {
	if (taskId === dependsOnTaskId) {
		throw new ValidationError("A task cannot depend on itself");
	}
	const task = getTask(handle, taskId);
	if (!task) throw new ValidationError(`Task ${taskId} not found`, 404);
	const dependsOn = getTask(handle, dependsOnTaskId);
	if (!dependsOn) throw new ValidationError(`Task ${dependsOnTaskId} not found`, 404);
	if (task.projectId !== dependsOn.projectId) {
		throw new ValidationError("Dependencies must be between tasks in the same project");
	}
	const existing = handle.db
		.select()
		.from(taskDependencies)
		.where(
			and(
				eq(taskDependencies.taskId, taskId),
				eq(taskDependencies.dependsOnTaskId, dependsOnTaskId),
			),
		)
		.get();
	if (existing) {
		throw new ValidationError(
			`Task ${taskId} already depends on task ${dependsOnTaskId}`,
			409,
		);
	}
	if (wouldCreateCycle(handle, taskId, dependsOnTaskId)) {
		throw new ValidationError("Adding this dependency would create a cycle");
	}
	return enqueueWrite(() =>
		handle.db.insert(taskDependencies).values({ taskId, dependsOnTaskId }).returning().get(),
	);
}

/** Remove a dependency edge. Returns false when the edge doesn't exist. */
export function removeDependency(
	handle: DbHandle,
	taskId: number,
	dependsOnTaskId: number,
): Promise<boolean> {
	return enqueueWrite(() => {
		const deleted = handle.db
			.delete(taskDependencies)
			.where(
				and(
					eq(taskDependencies.taskId, taskId),
					eq(taskDependencies.dependsOnTaskId, dependsOnTaskId),
				),
			)
			.returning()
			.get();
		return deleted !== undefined;
	});
}

/** List the dependency edges of a task (prerequisite ids). */
export function listDependencyIds(handle: DbHandle, taskId: number): number[] {
	return handle.db
		.select({ dependsOnTaskId: taskDependencies.dependsOnTaskId })
		.from(taskDependencies)
		.where(eq(taskDependencies.taskId, taskId))
		.all()
		.map((row) => row.dependsOnTaskId);
}

/**
 * Promote every backlog task whose dependencies ALL have a non-null
 * merge_sha (vacuously true for zero deps) to ready — the §6 canonical
 * query, scoped to one project when `projectId` is given. Each promotion is
 * its own guarded update + `task.state_changed` event inside ONE writer
 * link. Returns the promoted rows.
 */
export function recomputeReadiness(
	handle: DbHandle,
	log: EventLog,
	projectId?: number,
): Promise<TaskRow[]> {
	return enqueueWrite(() => {
		const db = handle.db;
		const dep = alias(tasks, "dep");
		// NOT EXISTS (… unmerged dependency …) — correlated on the outer tasks row.
		const unmergedDep = db
			.select({ one: sql`1` })
			.from(taskDependencies)
			.innerJoin(dep, eq(dep.id, taskDependencies.dependsOnTaskId))
			.where(and(eq(taskDependencies.taskId, tasks.id), isNull(dep.mergeSha)));
		const candidates = db
			.select()
			.from(tasks)
			.where(
				and(
					eq(tasks.state, "backlog"),
					projectId === undefined ? undefined : eq(tasks.projectId, projectId),
					notExists(unmergedDep),
				),
			)
			.all();

		const promoted: TaskRow[] = [];
		const now = new Date().toISOString();
		for (const candidate of candidates) {
			const updated = db
				.update(tasks)
				.set({ state: "ready", updatedAt: now })
				.where(and(eq(tasks.id, candidate.id), eq(tasks.state, "backlog")))
				.returning()
				.get();
			if (!updated) continue; // lost race with a concurrent transition — no-op
			log.emitInWriter({
				projectId: candidate.projectId,
				taskId: candidate.id,
				kind: TASK_STATE_CHANGED,
				payload: {
					taskId: candidate.id,
					from: "backlog",
					to: "ready",
					actor: "system",
					trigger: "deps_merged",
				},
			});
			promoted.push(updated);
		}
		return promoted;
	});
}
