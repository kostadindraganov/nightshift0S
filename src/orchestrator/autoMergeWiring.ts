/**
 * WHY: INTEGRATION wiring that binds the C1 forge primitives (autoMergePreflight,
 * mergePullRequest) and the per-task MergeContext resolver to the C2 orchestrator
 * (tryAutoMerge), then subscribes the auto-merge hook to the event log
 * (PHASE5C-CONTRACT §8.2/§8.3).
 *
 * The C2 `AutoMergeDeps` shape this binds against takes per-taskId closures
 * (`preflight(taskId)`, `mergePullRequest(taskId)`) rather than the contract's
 * idealized per-ctx ports — so this module owns the context-resolution step and
 * feeds the live ForgeClient + config.forge.trustedCheckAppIds into C1.
 *
 * resolveMergeContext (§8.3): prNumber ← latest `task.pr_opened` event;
 * approvedSha ← latest verdict thread event with payload.verdict==="approved";
 * headSha ← same approvedSha, cross-checked against the latest coder run's
 * head_sha when present; owner/repo/baseBranch ← RepoConfig (defaultBranch is the
 * branch NAME). Any missing piece ⇒ the merge fails closed.
 *
 * FAIL-CLOSED + GATED: the whole hook is started ONLY from main.ts's
 * `import.meta.main` dev path and only when `review.autoMergeEnabled` is true.
 * `createServer()` never starts it, so the test suite is unaffected (no live
 * ForgeClient, no GitHub call, no subscription). tryAutoMerge itself also gates
 * on the knob, so even a started hook with the knob off is inert.
 */

import { and, desc, eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { NightshiftConfig } from "../config/config.ts";
import type { TaskRow } from "../db/schema.ts";
import { events } from "../db/schema.ts";
import type { ForgeClient } from "../forge/github.ts";
import { autoMergePreflight } from "../forge/preflight.ts";
import { mergePullRequest } from "../forge/mergeClient.ts";
import { getThread } from "../thread/thread.ts";
import { listRuns } from "../runs/runs.ts";
import { getTask } from "../tasks/tasks.ts";
import { TASK_STATE_CHANGED } from "../tasks/transitions.ts";
import { tryAutoMerge, type AutoMergeDeps, type AutoMergeOutcome } from "./autoMerge.ts";

/** Everything the merge needs, resolved per task (PHASE5C-CONTRACT §4.1 MergeContext). */
export interface MergeContext {
	owner: string;
	repo: string;
	prNumber: number;
	baseBranch: string;
	headSha: string;
	approvedSha: string;
}

/** Repo coordinates the host resolves per task (subset of coder.RepoConfig). */
export interface RepoCoordinates {
	owner: string;
	repo: string;
	/** Protected branch NAME (RepoConfig.defaultBranch) — not a SHA. */
	defaultBranch: string;
}

// ---------------------------------------------------------------------------
// resolveMergeContext (§8.3)
// ---------------------------------------------------------------------------

/** Latest `task.pr_opened` event's PR number for the task, or null. */
function latestPrNumber(handle: DbHandle, taskId: number): number | null {
	const rows = handle.db
		.select()
		.from(events)
		.where(and(eq(events.taskId, taskId), eq(events.kind, "task.pr_opened")))
		.orderBy(desc(events.seq))
		.limit(1)
		.all();
	const row = rows[0];
	if (row === undefined) return null;
	try {
		const payload = JSON.parse(row.payloadJson) as { pr?: { number?: unknown } };
		const n = payload.pr?.number;
		return typeof n === "number" ? n : null;
	} catch {
		return null;
	}
}

/** approvedSha from the latest verdict thread event whose verdict === "approved". */
function latestApprovedSha(handle: DbHandle, taskId: number): string | null {
	const thread = getThread(handle, taskId);
	// getThread is ascending by seq; scan from the end for the newest approval.
	for (let i = thread.length - 1; i >= 0; i--) {
		const ev = thread[i];
		if (ev === undefined || ev.kind !== "verdict") continue;
		try {
			const payload = JSON.parse(ev.payloadJson) as { verdict?: unknown; headSha?: unknown };
			if (payload.verdict === "approved" && typeof payload.headSha === "string") {
				return payload.headSha;
			}
		} catch {
			// malformed payload — skip.
		}
	}
	return null;
}

/** Newest coder run's head_sha for the task, when present. */
function latestCoderHeadSha(handle: DbHandle, taskId: number): string | null {
	const runs = listRuns(handle, { taskId });
	let best: { id: number; headSha: string } | null = null;
	for (const r of runs) {
		if (r.kind !== "coder" || r.headSha === null) continue;
		if (best === null || r.id > best.id) best = { id: r.id, headSha: r.headSha };
	}
	return best?.headSha ?? null;
}

/**
 * Build the per-task MergeContext. Any missing piece returns null so the merge
 * fails closed. `resolveRepo` is host-owned (only the host knows how a project's
 * repoUrl maps to owner/repo/defaultBranch).
 */
export function makeResolveMergeContext(deps: {
	handle: DbHandle;
	resolveRepo: (task: TaskRow) => RepoCoordinates | null;
}): (taskId: number) => MergeContext | null {
	return (taskId) => {
		const task = getTask(deps.handle, taskId);
		if (task === null) return null;
		const repo = deps.resolveRepo(task);
		if (repo === null) return null;
		const prNumber = latestPrNumber(deps.handle, taskId);
		if (prNumber === null) return null;
		const approvedSha = latestApprovedSha(deps.handle, taskId);
		if (approvedSha === null) return null;
		// §8.3 cross-check: the latest coder run's head_sha must MATCH the approved
		// SHA. If a post-approval coder push recorded a run with a different head,
		// fail closed (return null) rather than carry the unapproved SHA. headSha is
		// always the approvedSha — the run head is a cross-check, not a source.
		const runHead = latestCoderHeadSha(deps.handle, taskId);
		if (runHead !== null && runHead !== approvedSha) return null;
		const headSha = approvedSha;
		return {
			owner: repo.owner,
			repo: repo.repo,
			prNumber,
			baseBranch: repo.defaultBranch,
			headSha,
			approvedSha,
		};
	};
}

// ---------------------------------------------------------------------------
// Production AutoMergeDeps
// ---------------------------------------------------------------------------

/**
 * Compose the production `AutoMergeDeps` for `tryAutoMerge`. The injected
 * `forgeClient` is HOST-SIDE (createGitHubForgeClient) — the token never reaches
 * an agent env. `preflight`/`mergePullRequest` resolve the MergeContext per task
 * and translate C1's results into the shapes C2 expects.
 */
export function makeAutoMergeDeps(deps: {
	handle: DbHandle;
	log: EventLog;
	config: NightshiftConfig;
	forgeClient: ForgeClient;
	resolveMergeContext: (taskId: number) => MergeContext | null;
}): AutoMergeDeps {
	const { handle, log, config, forgeClient, resolveMergeContext } = deps;
	// §4.1: resolve the MergeContext ONCE per tryAutoMerge attempt and share it
	// between preflight and merge. preflight (always called first by C2) resolves
	// and caches the ctx; merge reuses the SAME ctx so it cannot execute against a
	// different context than the one preflight validated. The cache is per-taskId
	// and is cleared once consumed by the merge so a later attempt re-resolves.
	const ctxCache = new Map<number, MergeContext>();
	return {
		handle,
		log,
		config: { review: { autoMergeEnabled: config.review.autoMergeEnabled } },
		preflight: async (taskId) => {
			const ctx = resolveMergeContext(taskId);
			ctxCache.delete(taskId);
			if (ctx === null) {
				return { pass: false, blocked: ["merge context unresolved"] };
			}
			const result = await autoMergePreflight(forgeClient, {
				owner: ctx.owner,
				repo: ctx.repo,
				prNumber: ctx.prNumber,
				baseBranch: ctx.baseBranch,
				headSha: ctx.headSha,
				approvedSha: ctx.approvedSha,
				trustedCheckAppIds: config.forge.trustedCheckAppIds,
			});
			// Cache ONLY a context that passed preflight so the merge step reuses it.
			if (result.ok) ctxCache.set(taskId, ctx);
			return { pass: result.ok, blocked: result.blocked };
		},
		mergePullRequest: async (taskId) => {
			// Reuse the exact context preflight validated — never re-resolve, which
			// would reopen the post-approval-push TOCTOU window.
			const ctx = ctxCache.get(taskId);
			ctxCache.delete(taskId);
			if (ctx === undefined) {
				throw new Error("merge context unresolved");
			}
			const result = await mergePullRequest(forgeClient, {
				owner: ctx.owner,
				repo: ctx.repo,
				prNumber: ctx.prNumber,
				// Arm GitHub's atomic 409-on-head-mismatch with the APPROVED SHA so
				// the server refuses to merge any head that is not the approved one,
				// regardless of resolution timing.
				sha: ctx.approvedSha,
				method: "squash",
			});
			if (!result.merged) {
				throw new Error(result.reason);
			}
			return result.mergeSha;
		},
	};
}

// ---------------------------------------------------------------------------
// The auto-merge hook (§8.2)
// ---------------------------------------------------------------------------

export interface AutoMergeHookHandle {
	stop(): void;
}

/**
 * Subscribe to the event log for `task.state_changed` with `payload.to ===
 * "approved"` and fire `tryAutoMerge(autoMergeDeps, taskId)` (the same wake
 * pattern as the Phase 5A scheduler). Returns a handle to stop the subscription.
 *
 * GATED: the caller starts this ONLY when `review.autoMergeEnabled` is true;
 * tryAutoMerge ALSO gates on the knob, so a started hook is doubly fail-closed.
 * `onOutcome` is an optional sink for logging/metrics (defaults to a no-op).
 */
export function startAutoMergeHook(deps: {
	log: EventLog;
	autoMergeDeps: AutoMergeDeps;
	onOutcome?: (taskId: number, outcome: AutoMergeOutcome) => void;
}): AutoMergeHookHandle {
	const controller = new AbortController();
	const sub = deps.log.subscribe({
		signal: controller.signal,
		filter: (ev) => ev.kind === TASK_STATE_CHANGED,
	});

	void (async () => {
		for await (const ev of sub) {
			let to: unknown;
			let taskId: unknown;
			try {
				const payload = JSON.parse(ev.payloadJson) as { to?: unknown; taskId?: unknown };
				to = payload.to;
				taskId = payload.taskId;
			} catch {
				continue;
			}
			if (to !== "approved" || typeof taskId !== "number") continue;
			const outcome = await tryAutoMerge(deps.autoMergeDeps, taskId);
			deps.onOutcome?.(taskId, outcome);
		}
	})();

	return {
		stop() {
			controller.abort();
			sub.close();
		},
	};
}
