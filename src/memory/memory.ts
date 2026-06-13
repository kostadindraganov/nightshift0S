/**
 * WHY: Per-project agent memory (BLUEPRINT §3 "Memory & knowledge"). Gives the
 * autonomous factory a durable key-value store per project, so lessons learned
 * across runs ("this repo needs NODE_ENV=test", "prefer pnpm") survive process
 * restarts and accumulate over time. Values are opaque JSON blobs stored in the
 * existing `agent_memory` table (Phase 6 migration 0002).
 *
 * Security invariant (§3.12.7): secret values must NOT be stored here — only
 * non-secret notes and references. The API does not accept or echo raw token-
 * shaped values. All writes ride the single serialized writer queue to avoid
 * concurrent upsert races on the UNIQUE(projectId, namespace, key) constraint.
 *
 * Three operations:
 *   getMemory   — point read (synchronous, direct).
 *   listMemory  — filtered list, newest updatedAt first.
 *   putMemory   — validated upsert; emits "memory.updated".
 *   deleteMemory — hard delete; emits "memory.deleted".
 */

import { and, desc, eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { projects, agentMemory, type AgentMemoryRow } from "../db/schema.ts";
import { enqueueWrite } from "../db/writer.ts";
import type { EventLog } from "../events/events.ts";

// Re-export for consumers (avoids forcing them to reach into schema.ts).
export type { AgentMemoryRow };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_NAMESPACE = "note";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Point-read a memory row by (projectId, namespace, key). Synchronous / direct. */
function selectMemory(
	handle: DbHandle,
	projectId: number,
	namespace: string,
	key: string,
): AgentMemoryRow | null {
	return (
		handle.db
			.select()
			.from(agentMemory)
			.where(
				and(
					eq(agentMemory.projectId, projectId),
					eq(agentMemory.namespace, namespace),
					eq(agentMemory.key, key),
				),
			)
			.get() ?? null
	);
}

/** Check a project row exists without fetching the full row. */
function projectExists(handle: DbHandle, projectId: number): boolean {
	return (
		handle.db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.id, projectId))
			.get() !== undefined
	);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a single memory entry. Returns null when absent.
 * Read-direct (no enqueueWrite needed).
 */
export function getMemory(
	handle: DbHandle,
	projectId: number,
	namespace: string,
	key: string,
): AgentMemoryRow | null {
	return selectMemory(handle, projectId, namespace, key);
}

/**
 * List memory entries for a project, newest updatedAt first.
 * Optionally filtered by namespace.
 */
export function listMemory(
	handle: DbHandle,
	projectId: number,
	opts?: { namespace?: string },
): AgentMemoryRow[] {
	const conditions = [eq(agentMemory.projectId, projectId)];
	if (opts?.namespace !== undefined) {
		conditions.push(eq(agentMemory.namespace, opts.namespace));
	}
	return handle.db
		.select()
		.from(agentMemory)
		.where(and(...conditions))
		.orderBy(desc(agentMemory.updatedAt))
		.all();
}

export interface PutMemoryInput {
	projectId: number;
	namespace?: string;
	key: string;
	value: unknown;
	source: string;
}

export type PutMemoryResult =
	| { ok: true; row: AgentMemoryRow }
	| { ok: false; reason: "project_not_found" | "invalid" };

/**
 * Upsert a memory entry by (projectId, namespace, key).
 *
 * Fail-closed:
 *   - project_not_found if projectId has no projects row.
 *   - invalid if key is empty or source is empty.
 *
 * The value is JSON.stringify'd into valueJson; raw token-shaped values are
 * never echoed in events (§3.12.7). Emits "memory.updated" with
 * {projectId, namespace, key, source, hadPrevious} — value is intentionally
 * omitted from the event payload to avoid leaking opaque blobs into the log.
 */
export async function putMemory(
	handle: DbHandle,
	log: EventLog,
	input: PutMemoryInput,
): Promise<PutMemoryResult> {
	const namespace = input.namespace ?? DEFAULT_NAMESPACE;

	// Validate before touching the writer queue.
	if (typeof input.key !== "string" || input.key.trim().length === 0) {
		return { ok: false, reason: "invalid" };
	}
	if (typeof input.source !== "string" || input.source.trim().length === 0) {
		return { ok: false, reason: "invalid" };
	}
	if (!projectExists(handle, input.projectId)) {
		return { ok: false, reason: "project_not_found" };
	}

	const valueJson = JSON.stringify(input.value);

	const row = await enqueueWrite((): AgentMemoryRow => {
		const now = new Date().toISOString();
		const existing = selectMemory(handle, input.projectId, namespace, input.key);
		const hadPrevious = existing !== null;

		let result: AgentMemoryRow;
		if (existing === null) {
			result = handle.db
				.insert(agentMemory)
				.values({
					projectId: input.projectId,
					namespace,
					key: input.key,
					valueJson,
					source: input.source,
					createdAt: now,
					updatedAt: now,
				})
				.returning()
				.get();
		} else {
			result = handle.db
				.update(agentMemory)
				.set({ valueJson, source: input.source, updatedAt: now })
				.where(eq(agentMemory.id, existing.id))
				.returning()
				.get();
		}

		// Emit in the same writer link — never echo value (§3.12.7).
		log.emitInWriter({
			kind: "memory.updated",
			payload: {
				projectId: input.projectId,
				namespace,
				key: input.key,
				source: input.source,
				hadPrevious,
			},
		});

		return result;
	});

	return { ok: true, row };
}

export interface DeleteMemoryInput {
	projectId: number;
	namespace?: string;
	key: string;
}

export type DeleteMemoryResult = { ok: true } | { ok: false; reason: "not_found" };

/**
 * Delete a memory entry. Returns not_found if absent.
 * Emits "memory.deleted" in the same writer link as the DELETE.
 */
export async function deleteMemory(
	handle: DbHandle,
	log: EventLog,
	input: DeleteMemoryInput,
): Promise<DeleteMemoryResult> {
	const namespace = input.namespace ?? DEFAULT_NAMESPACE;

	const result = await enqueueWrite((): "not_found" | "ok" => {
		const existing = selectMemory(handle, input.projectId, namespace, input.key);
		if (existing === null) return "not_found";

		handle.db.delete(agentMemory).where(eq(agentMemory.id, existing.id)).run();

		log.emitInWriter({
			kind: "memory.deleted",
			payload: {
				projectId: input.projectId,
				namespace,
				key: input.key,
			},
		});

		return "ok";
	});

	if (result === "not_found") {
		return { ok: false, reason: "not_found" };
	}
	return { ok: true };
}
