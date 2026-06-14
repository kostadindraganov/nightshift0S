/**
 * WHY: Fires completeCoderRun whenever a coder run transitions to "succeeded",
 * closing the GATE-2 live gap (prodDeps.ts notes there is currently NO
 * production caller of completeCoderRun). Subscribes TAIL-ONLY to
 * "run.state_changed" events — no history replay — and is completely inert at
 * import time.
 *
 * FAIL-CLOSED: every per-event error is caught, logged, and skipped; the loop
 * never re-throws. buildProdCoderDeps throws on a missing GITHUB_TOKEN — that
 * is correct and expected; catch it, warn, and continue so the next succeeded
 * run gets a fresh attempt.
 */

import { sql, eq, and } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { TaskRow, RunRow } from "../db/schema.ts";
import { events, runs, tasks } from "../db/schema.ts";
import { getRun } from "../runs/runs.ts";
import { RUN_STATE_CHANGED } from "../runs/transitions.ts";
import {
	completeCoderRun,
	type CoderOrchestratorDeps,
	type RepoConfig,
} from "./coder.ts";
import {
	buildProdCoderDeps,
	type ProdCoderDepsInput,
} from "./prodDeps.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CoderCompletionTriggerDeps {
	handle: DbHandle;
	log: EventLog;
	/**
	 * Maps a (task, run) pair to the local repo coordinates the orchestrator
	 * needs (repoDir, worktreePath, remoteUrl, owner, repo, defaultBranch, …).
	 * The parent owns this closure because only it knows how project.repoUrl
	 * maps to a local checkout.
	 */
	resolveRepo: (task: TaskRow, run: RunRow) => RepoConfig;
	/**
	 * Injectable factory for CoderOrchestratorDeps — lets tests bypass real
	 * GITHUB_TOKEN/git/network. Production leaves this undefined and the
	 * module falls back to buildProdCoderDeps.
	 */
	buildDeps?: (input: ProdCoderDepsInput) => Promise<CoderOrchestratorDeps>;
}

// ---------------------------------------------------------------------------
// parsePayload — mirrors scheduler.ts (verbatim shape)
// ---------------------------------------------------------------------------

function parsePayload(payloadJson: string): { to?: string; from?: string; trigger?: string } {
	try {
		const parsed = JSON.parse(payloadJson) as unknown;
		if (parsed !== null && typeof parsed === "object") {
			return parsed as { to?: string; from?: string; trigger?: string };
		}
	} catch {
		// Malformed payload → inert empty object.
	}
	return {};
}

// ---------------------------------------------------------------------------
// startCoderCompletionTrigger
// ---------------------------------------------------------------------------

/**
 * Subscribe to run.state_changed events and call completeCoderRun whenever a
 * coder run succeeds. Returns { stop() } which closes the subscription.
 *
 * Must be called exactly once, inside onReady — never at module load time.
 */
export function startCoderCompletionTrigger(
	deps: CoderCompletionTriggerDeps,
): { stop(): void } {
	const { handle, log, resolveRepo } = deps;
	const buildDepsFactory = deps.buildDeps ?? buildProdCoderDeps;

	let stopped = false;

	// TAIL-ONLY: compute current max seq BEFORE subscribing so no history is
	// replayed on boot. Mirrors scheduler.ts lines 278-282 exactly.
	const startSeq =
		handle.db
			.select({ max: sql<number>`coalesce(max(${events.seq}), 0)` })
			.from(events)
			.get()?.max ?? 0;

	// Boot reconciliation: find succeeded coder runs whose tasks are still in
	// `coding` (completeCoderRun never fired, e.g. service restarted mid-pipeline).
	// Run them now, after the subscription is set so new events aren't missed.
	void (async () => {
		const pending = handle.db
			.select({ run: runs })
			.from(runs)
			.innerJoin(tasks, eq(tasks.id, runs.taskId))
			.where(and(eq(runs.state, "succeeded"), eq(runs.kind, "coder"), eq(tasks.state, "coding")))
			.all()
			.map((r) => r.run);
		for (const run of pending) {
			if (stopped) break;
			if (run.taskId === null) continue;
			const { getTask } = await import("../tasks/tasks.ts");
			const task = getTask(handle, run.taskId);
			if (task === null) continue;
			let cfg: RepoConfig;
			try {
				cfg = resolveRepo(task, run);
			} catch {
				continue;
			}
			let coderDeps: CoderOrchestratorDeps;
			try {
				coderDeps = await buildDepsFactory({ handle, log, resolveRepo, owner: cfg.owner, repo: cfg.repo });
			} catch {
				continue;
			}
			try {
				await completeCoderRun(coderDeps, run.id);
			} catch (err) {
				console.warn(`[coderCompletionTrigger] boot_reconcile run ${run.id}: ${err instanceof Error ? err.message : err}`);
			}
		}
	})();

	const subscription = log.subscribe({
		afterSeq: startSeq,
		filter: (e) => e.kind === RUN_STATE_CHANGED,
	});

	void (async () => {
		for await (const event of subscription) {
			if (stopped) break;

			// --- guard chain ---------------------------------------------------

			// (a) Parse payload; malformed → skip.
			const payload = parsePayload(event.payloadJson);

			// (b) Only care about runs that just succeeded.
			if (payload.to !== "succeeded") continue;

			// (c) Must have a runId.
			if (event.runId === null || event.runId === undefined) continue;
			const runId = event.runId;

			// (d) Run must exist in DB.
			const run = getRun(handle, runId);
			if (run === null) {
				console.warn(`[coderCompletionTrigger] run ${runId} not found in DB — skipping`);
				await log.emitEvent({
					kind: "coder.completion.error",
					runId,
					payload: { error: "run not found", runId },
				}).catch(() => undefined);
				continue;
			}

			// (e) Only coder runs — skip reviewer / other kinds silently.
			if (run.kind !== "coder") continue;

			// (f) Defensive: confirm the DB state matches the event payload.
			// completeCoderRun also checks this, but a fresh read may differ in
			// an edge race — treat as non-actionable rather than crashing.
			if (run.state !== "succeeded") continue;

			// --- build prod deps (per-event; resolves GITHUB_TOKEN each time) ---

			// Extract owner/repo from the resolved RepoConfig so the CiClient
			// targets the correct repository, even in multi-project deployments.
			// We need the task to call resolveRepo; but we only have the runId at
			// this point. completeCoderRun will re-fetch the task internally.
			// For buildProdCoderDeps we need owner/repo NOW, so we resolve the
			// repo config early (getRun gives us the run; we need the task).
			// Use run.taskId for a lightweight getTask-equivalent via getRun data.
			//
			// Strategy: call resolveRepo with a minimal stub that carries only the
			// fields buildProdCoderDeps needs from (task, run). Since resolveRepo
			// is provided by the parent closure and uses project.repoUrl — which
			// maps through the DB — we need the real task. We do a lightweight DB
			// read here just to get owner/repo for the CiClient; completeCoderRun
			// does its own authoritative read internally.

			let cfg: RepoConfig;
			try {
				// We need the task to resolve the repo. Import getTask inline to
				// avoid a circular at module top (getTask is a simple DB read).
				const { getTask } = await import("../tasks/tasks.ts");
				if (run.taskId === null || run.taskId === undefined) {
					// No task — completeCoderRun will handle the outcome:failed path.
					// We cannot resolve owner/repo; skip building deps here.
					console.warn(`[coderCompletionTrigger] run ${runId} has no taskId — skipping`);
					continue;
				}
				const task = getTask(handle, run.taskId);
				if (task === null) {
					console.warn(`[coderCompletionTrigger] task ${run.taskId} not found for run ${runId} — skipping`);
					continue;
				}
				cfg = resolveRepo(task, run);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[coderCompletionTrigger] resolveRepo failed for run ${runId}: ${msg}`);
				await log.emitEvent({
					kind: "coder.completion.error",
					runId,
					payload: { error: msg, runId, phase: "resolveRepo" },
				}).catch(() => undefined);
				continue;
			}

			let coderDeps: CoderOrchestratorDeps;
			try {
				coderDeps = await buildDepsFactory({
					handle,
					log,
					resolveRepo,
					owner: cfg.owner,
					repo: cfg.repo,
				});
			} catch (err) {
				// GITHUB_TOKEN absent (or gh auth token failed) — fail-closed.
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[coderCompletionTrigger] buildDeps failed for run ${runId}: ${msg}`);
				await log.emitEvent({
					kind: "coder.completion.error",
					runId,
					payload: { error: msg, runId, phase: "buildDeps" },
				}).catch(() => undefined);
				continue;
			}

			// --- call completeCoderRun -------------------------------------------
			try {
				await completeCoderRun(coderDeps, runId);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[coderCompletionTrigger] completeCoderRun threw for run ${runId}: ${msg}`);
				await log.emitEvent({
					kind: "coder.completion.error",
					runId,
					payload: { error: msg, runId, phase: "completeCoderRun" },
				}).catch(() => undefined);
				// Continue — the orchestrator's internal state guards handle
				// escalation to needs_human; our job is just to not crash the loop.
			}
		}
	})();

	function stop(): void {
		stopped = true;
		subscription.close();
	}

	return { stop };
}
