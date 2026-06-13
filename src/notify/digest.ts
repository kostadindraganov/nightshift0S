/**
 * WHY: Morning standup digest (BLUEPRINT §3.5). Aggregates task/run state over a
 * configurable time window and formats it as a human-readable NotifyMessage for
 * delivery via any Notifier channel.
 *
 * Three exports:
 *   buildStandupDigest — query the DB for the window, return a typed summary.
 *   digestToMessage    — format a StandupDigest as a NotifyMessage.
 *   makeDigestScheduler — optionally schedule periodic digest delivery (inject
 *                         everything; no auto-start at import time).
 *
 * All DB reads are direct (no enqueueWrite — reads are always safe). Writes
 * never happen here; we only read. Clock is injectable for testability.
 */

import { and, gte, lt } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { RUN_TERMINAL_STATES } from "../db/columns.ts";
import { runs, tasks } from "../db/schema.ts";
import type { ChannelResult, NotifyMessage } from "./notifier.ts";

// Structural alias — accepts the real Notifier class or any fake in tests.
interface NotifierLike {
	notify(msg: NotifyMessage): Promise<ChannelResult[]>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StandupDigest {
	window: {
		sinceTs: string;
		untilTs: string;
	};
	/** Tasks currently in "done" state. */
	done: number;
	/** Tasks currently in "failed" state. */
	failed: number;
	/** Tasks currently in "needs_human" state. */
	needsHuman: number;
	/** Tasks with a non-null merge_sha (successfully merged). */
	merged: number;
	/** Runs in non-terminal states (active right now). */
	activeRuns: number;
	/** Sum of cost_usd for priced runs that ended in the window. */
	spendUsd: number;
	/** Runs in the window with exit_reason containing "flaky" or "retry". */
	flaky: number;
	/** Top exit_reason tallies (non-null, non-flaky, descending count). */
	topErrors: { reason: string; count: number }[];
}

export interface DigestOpts {
	/** ISO8601 timestamp — window start (inclusive). */
	sinceTs: string;
	/** Override the current time (defaults to new Date()). */
	now?: () => Date;
}

// ---------------------------------------------------------------------------
// buildStandupDigest
// ---------------------------------------------------------------------------

/**
 * Compute a standup digest from the DB.
 *
 * Task counts (done/failed/needsHuman/merged) are global state snapshots —
 * they reflect the current DB state, not just the window, because task counts
 * are more meaningful as "current queue depth" than "changed in window".
 *
 * Run metrics (spendUsd, flaky, topErrors, activeRuns) are filtered to runs
 * whose endedAt falls in [sinceTs, untilTs) to capture what happened overnight.
 * activeRuns reflects non-terminal runs at query time (no time filter).
 */
export function buildStandupDigest(
	handle: DbHandle,
	opts: DigestOpts,
): StandupDigest {
	const now = opts.now ? opts.now() : new Date();
	const untilTs = now.toISOString();
	const { sinceTs } = opts;

	// --- Task state snapshots (global, no time filter) ---
	const allTasks = handle.db.select().from(tasks).all();
	const done = allTasks.filter((t) => t.state === "done").length;
	const failed = allTasks.filter((t) => t.state === "failed").length;
	const needsHuman = allTasks.filter((t) => t.state === "needs_human").length;
	const merged = allTasks.filter((t) => t.mergeSha !== null).length;

	// --- Runs in window (endedAt between sinceTs and untilTs) ---
	const windowRuns = handle.db
		.select()
		.from(runs)
		.where(and(gte(runs.endedAt, sinceTs), lt(runs.endedAt, untilTs)))
		.all();

	// Sum cost for priced runs only (§3.12.15).
	const spendUsd = windowRuns
		.filter((r) => r.priced && r.costUsd !== null && r.costUsd !== undefined)
		.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

	// Flaky = exit_reason contains "flaky" or "retry" (case-insensitive).
	const flaky = windowRuns.filter(
		(r) => r.exitReason !== null && r.exitReason !== undefined &&
			/flaky|retry/i.test(r.exitReason),
	).length;

	// Top errors: non-null exitReason, excluding flaky/retry, tally by reason.
	const errorCounts = new Map<string, number>();
	for (const r of windowRuns) {
		if (!r.exitReason) continue;
		if (/flaky|retry/i.test(r.exitReason)) continue;
		errorCounts.set(r.exitReason, (errorCounts.get(r.exitReason) ?? 0) + 1);
	}
	const topErrors = Array.from(errorCounts.entries())
		.map(([reason, count]) => ({ reason, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 5);

	// Active runs = non-terminal states right now (no time filter).
	const terminalSet = new Set<string>(RUN_TERMINAL_STATES);
	const activeRuns = handle.db
		.select()
		.from(runs)
		.all()
		.filter((r) => !terminalSet.has(r.state)).length;

	return {
		window: { sinceTs, untilTs },
		done,
		failed,
		needsHuman,
		merged,
		activeRuns,
		spendUsd: Math.round(spendUsd * 1e6) / 1e6, // avoid FP drift
		flaky,
		topErrors,
	};
}

// ---------------------------------------------------------------------------
// digestToMessage
// ---------------------------------------------------------------------------

/**
 * Format a StandupDigest as a NotifyMessage suitable for any Channel.
 * Produces a compact, human-readable body. Title is always non-empty.
 */
export function digestToMessage(d: StandupDigest): NotifyMessage {
	const since = d.window.sinceTs.slice(0, 16).replace("T", " ");
	const until = d.window.untilTs.slice(0, 16).replace("T", " ");

	const lines: string[] = [
		`Window: ${since} → ${until}`,
		``,
		`Tasks  : done=${d.done}  failed=${d.failed}  needs_human=${d.needsHuman}  merged=${d.merged}`,
		`Runs   : active=${d.activeRuns}  flaky=${d.flaky}  spend=$${d.spendUsd.toFixed(4)}`,
	];

	if (d.topErrors.length > 0) {
		lines.push(``, `Top exit reasons:`);
		for (const e of d.topErrors) {
			lines.push(`  ${e.count}x  ${e.reason}`);
		}
	}

	return {
		kind: "digest.standup",
		title: "Nightshift standup digest",
		body: lines.join("\n"),
		severity: d.failed > 0 || d.needsHuman > 0 ? "warn" : "info",
	};
}

// ---------------------------------------------------------------------------
// makeDigestScheduler
// ---------------------------------------------------------------------------

export interface DigestSchedulerDeps {
	handle: DbHandle;
	notifier: NotifierLike;
	/** Clock for "now" and for computing sinceTs = now - sinceWindowMs. */
	now: () => Date;
	/** How often to fire (ms). */
	intervalMs: number;
	/** How far back the digest window reaches (ms). e.g. 8h = 8*60*60*1000. */
	sinceWindowMs: number;
}

export interface DigestScheduler {
	stop(): void;
}

/**
 * Periodically build a standup digest and deliver it via the notifier.
 * Does NOT start at import time — call makeDigestScheduler() to start.
 * Inject all side effects (handle, notifier, now, intervals) for testability.
 * Errors from notifier.notify() are swallowed so a broken channel never
 * stops the scheduler.
 */
export function makeDigestScheduler(deps: DigestSchedulerDeps): DigestScheduler {
	const { handle, notifier, now, intervalMs, sinceWindowMs } = deps;

	const timer = setInterval(async () => {
		try {
			const currentNow = now();
			const sinceTs = new Date(currentNow.getTime() - sinceWindowMs).toISOString();
			const digest = buildStandupDigest(handle, { sinceTs, now: () => currentNow });
			const msg = digestToMessage(digest);
			await notifier.notify(msg);
		} catch {
			// FAIL-CLOSED: errors must not stop the scheduler loop.
		}
	}, intervalMs);

	// Prevent Node/Bun from keeping the process alive just for this timer.
	if (typeof timer === "object" && timer !== null && "unref" in timer) {
		(timer as { unref(): void }).unref();
	}

	return {
		stop(): void {
			clearInterval(timer);
		},
	};
}
