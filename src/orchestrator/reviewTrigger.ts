/**
 * WHY: Closes the GATE-3 live gap by firing runReviewRound automatically
 * whenever a task transitions into the 'review' state. Without this trigger,
 * review rounds only start via an explicit HTTP POST; tasks waiting in 'review'
 * sit idle forever. startReviewTrigger subscribes (TAIL-ONLY) to
 * task.state_changed events and calls runReviewRound for every task that lands
 * in 'review'. FAIL-CLOSED: a throw or { ok: false } from runReviewRound is
 * logged and the loop continues — no crash, no retry storm.
 *
 * All side effects (ReviewDeps assembly, EventLog subscription) are deferred
 * until startReviewTrigger(deps) is called so this module is inert at import
 * time and safe under the test suite's createServer boot.
 */

import { sql } from "drizzle-orm";
import { events } from "../db/schema.ts";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { NightshiftConfig } from "../config/config.ts";
import type { ReviewDeps } from "./review.ts";
import { runReviewRound } from "./review.ts";
import { threadApi } from "../thread/thread.ts";
import { runVerdict } from "../review/engine.ts";
import { codeReviewJudge } from "../review/judge.ts";
import {
	makeGetDiff,
	makeRunReviewer,
	makeTournamentReviewer,
	makeResumeCoder,
} from "../runs/liveSpawn.ts";
import { TmuxLauncher } from "../runs/launcher.ts";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ReviewTriggerDeps {
	handle: DbHandle;
	log: EventLog;
	config: NightshiftConfig;
	/** Local path to the git repo. When omitted, makeResumeCoder fails closed on invocation. */
	repoDir?: string;
	/** Overrides config.providers.defaultReviewer. */
	reviewerProvider?: string;
	/** Overrides config.tournament.challengerProvider. */
	tournamentChallengerProvider?: string;
	/**
	 * Injectable factory that assembles a ReviewDeps for a given taskId.
	 * Production default assembles the real wiring; tests inject a fake to
	 * avoid real spawns, git calls, or DB side effects.
	 */
	buildReviewDeps?: (deps: ReviewTriggerDeps) => ReviewDeps;
}

export interface ReviewTriggerHandle {
	stop(): void;
}

// ---------------------------------------------------------------------------
// Default ReviewDeps builder (production wiring)
// ---------------------------------------------------------------------------

function defaultBuildReviewDeps(deps: ReviewTriggerDeps): ReviewDeps {
	const { handle, log, config } = deps;
	const repoDir = deps.repoDir ?? process.env.NIGHTSHIFT_REPO_DIR;
	const reviewerProvider =
		deps.reviewerProvider ?? config.providers.defaultReviewer;
	const tournamentChallengerProvider =
		deps.tournamentChallengerProvider ?? config.tournament.challengerProvider;
	const homeRoot = config.sandbox.homeRoot;

	const liveDepsBase = { handle, log, homeRoot, reviewerProvider, tournamentChallengerProvider };

	const runReviewer = config.tournament.enabled
		? makeTournamentReviewer(liveDepsBase)
		: makeRunReviewer({ ...liveDepsBase });

	return {
		handle,
		log,
		thread: threadApi,
		engine: runVerdict as ReviewDeps["engine"],
		judge: codeReviewJudge as ReviewDeps["judge"],
		getDiff: makeGetDiff({ handle, log }),
		runReviewer,
		resumeCoder: makeResumeCoder({
			handle,
			log,
			launcher: new TmuxLauncher(),
			homeRoot,
			...(repoDir ? { repoDir } : {}),
		}),
		maxRounds: config.review.maxRounds,
	};
}

// ---------------------------------------------------------------------------
// startReviewTrigger
// ---------------------------------------------------------------------------

/**
 * Subscribe (TAIL-ONLY) to task.state_changed events and call runReviewRound
 * for every task that enters the 'review' state. Returns a handle whose
 * stop() closes the subscription and terminates the loop.
 *
 * The function is synchronous; the async event-consumption loop runs as a
 * detached void IIFE (same pattern as scheduler.ts). All per-event errors are
 * caught and logged — the loop never crashes.
 */
export function startReviewTrigger(deps: ReviewTriggerDeps): ReviewTriggerHandle {
	const { handle, log } = deps;
	const buildDeps = deps.buildReviewDeps ?? defaultBuildReviewDeps;

	// TAIL-ONLY: capture the current max seq so history is never replayed.
	const startSeq =
		handle.db
			.select({ max: sql<number>`coalesce(max(${events.seq}), 0)` })
			.from(events)
			.get()?.max ?? 0;

	let stopped = false;

	const subscription = log.subscribe({
		afterSeq: startSeq,
		filter: (e) => e.kind === "task.state_changed",
	});

	void (async () => {
		for await (const event of subscription) {
			if (stopped) break;

			// Guard: taskId must be present on the event row.
			if (event.taskId == null) {
				console.warn("[reviewTrigger] task.state_changed event missing taskId — skipping", {
					seq: event.seq,
				});
				continue;
			}

			// Parse payload; malformed JSON must be inert.
			let payload: { to?: unknown } = {};
			try {
				const raw: unknown = JSON.parse(event.payloadJson ?? "null");
				if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
					payload = raw as { to?: unknown };
				}
			} catch {
				console.warn("[reviewTrigger] malformed payloadJson — skipping", {
					seq: event.seq,
					taskId: event.taskId,
				});
				continue;
			}

			// Only act when the task just entered 'review'.
			if (payload.to !== "review") continue;

			const taskId = event.taskId;

			// Assemble live ReviewDeps and run the review round, fail-closed.
			try {
				const reviewDeps = buildDeps(deps);
				const outcome = await runReviewRound(reviewDeps, taskId);
				if (!outcome.ok) {
					console.warn("[reviewTrigger] runReviewRound returned not-ok", {
						taskId,
						reason: outcome.reason,
					});
				}
			} catch (err) {
				console.error("[reviewTrigger] runReviewRound threw — continuing loop", {
					taskId,
					err: err instanceof Error ? err.message : String(err),
				});
			}
		}
	})();

	return {
		stop(): void {
			stopped = true;
			subscription.close();
		},
	};
}
