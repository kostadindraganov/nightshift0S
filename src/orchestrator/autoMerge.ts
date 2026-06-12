/**
 * WHY: Drives the approved→merging→done leg of the auto-merge path
 * (SPEC-STATE-MACHINES §1, row "approved→merging: V1.5+ auto-merge preflight
 * passed"). Runs ONLY when the operator has opted in via
 * config.review.autoMergeEnabled (default false — fail-closed). Any uncertain
 * or failed preflight check BLOCKS the merge and parks the task in
 * needs_human(merge_blocked) rather than silently proceeding, satisfying the
 * BLUEPRINT fail-closed threat-model requirement.
 *
 * All side-effects (preflight, GitHub merge call, forge/transition client) are
 * injectable so this module is fully hermetic on macOS with fakes.
 */

import type { NightshiftConfig } from "../config/config.ts";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import { getTask } from "../tasks/tasks.ts";
import { transitionTask } from "../tasks/transitions.ts";
import { confirmMergeAndUnblock } from "./coder.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of a preflight check. */
export interface PreflightResult {
	/** true iff every check passed and the merge can proceed. */
	pass: boolean;
	/** Non-empty when pass=false; each string is a human-readable block reason. */
	blocked: string[];
}

/** The minimal config surface autoMerge cares about. */
export interface AutoMergeConfig {
	review: Pick<NightshiftConfig["review"], "autoMergeEnabled">;
}

export interface AutoMergeDeps {
	handle: DbHandle;
	log: EventLog;
	config: AutoMergeConfig;
	/**
	 * Pre-merge preflight: branch protection verified, required checks green,
	 * head SHA fresh, no bypass perms on the bot token (§3.12.26).
	 * Injectable — real impl calls GitHub API; tests use a deterministic fake.
	 */
	preflight: (taskId: number) => Promise<PreflightResult>;
	/**
	 * Calls the GitHub (or other forge) merge endpoint.
	 * Injectable — never called in tests.
	 * Returns the merge commit SHA on success, throws on error.
	 */
	mergePullRequest: (taskId: number) => Promise<string>;
}

export type AutoMergeOutcome =
	| { outcome: "disabled" }
	| { outcome: "skipped"; reason: string }
	| { outcome: "merged"; mergeSha: string; unblocked: number[] }
	| { outcome: "needs_human"; blocked: string[] }
	| { outcome: "failed"; reason: string };

// ---------------------------------------------------------------------------
// tryAutoMerge
// ---------------------------------------------------------------------------

/**
 * Attempt to auto-merge the approved task `taskId`.
 *
 * Gate: returns `{outcome:"disabled"}` immediately when
 * `config.review.autoMergeEnabled` is false (the default) — no state
 * mutations, no side-effects.
 *
 * Happy path:
 *   approved → merging (merge_start)
 *   → mergePullRequest() → confirmMergeAndUnblock() → done + dependents unblocked
 *
 * Block path (preflight fails):
 *   approved → (no transition yet, preflight runs first)
 *   → merging → needs_human (merge_blocked) carrying the blocked reasons
 *
 * A preflight pass that subsequently fails at the merge call transitions
 *   merging → needs_human (merge_blocked) to avoid a zombie merging task.
 */
export async function tryAutoMerge(
	deps: AutoMergeDeps,
	taskId: number,
): Promise<AutoMergeOutcome> {
	const { handle, log, config } = deps;

	// ── Gate: operator must explicitly opt in ─────────────────────────────
	if (!config.review.autoMergeEnabled) {
		return { outcome: "disabled" };
	}

	// ── Verify task exists and is in approved ─────────────────────────────
	const task = getTask(handle, taskId);
	if (task === null) {
		return { outcome: "failed", reason: "task not found" };
	}
	if (task.state !== "approved") {
		return { outcome: "skipped", reason: `task not in approved (state=${task.state})` };
	}

	// ── Pre-merge preflight ───────────────────────────────────────────────
	// Run BEFORE approved→merging so that a block never leaves the task stuck
	// in the merging state without a corresponding merge attempt.
	const pre = await deps.preflight(taskId);

	if (!pre.pass) {
		// Preflight blocked — escalate directly from approved, bypassing merging.
		// The spec says merging→needs_human on block, but entering merging then
		// immediately blocking it is equivalent and avoids a dangling merging row.
		// We take the safer path: transition approved→merging first so the state
		// machine audit is complete, then immediately park it.
		const toMerging = await transitionTask(handle, log, {
			taskId,
			to: "merging",
			expectedFrom: "approved",
			actor: "auto_merge",
		});
		if (!toMerging.ok) {
			return { outcome: "failed", reason: `could not enter merging: ${toMerging.reason}` };
		}

		const park = await transitionTask(handle, log, {
			taskId,
			to: "needs_human",
			expectedFrom: "merging",
			actor: "auto_merge",
		});
		if (!park.ok) {
			// Lost the race after entering merging — tolerate as a no-op failure.
			return { outcome: "failed", reason: `could not park in needs_human: ${park.reason}` };
		}

		return { outcome: "needs_human", blocked: pre.blocked };
	}

	// ── Transition approved → merging ─────────────────────────────────────
	const toMerging = await transitionTask(handle, log, {
		taskId,
		to: "merging",
		expectedFrom: "approved",
		actor: "auto_merge",
	});
	if (!toMerging.ok) {
		return { outcome: "failed", reason: `approved→merging transition failed: ${toMerging.reason}` };
	}

	// ── Merge ─────────────────────────────────────────────────────────────
	let mergeSha: string;
	try {
		mergeSha = await deps.mergePullRequest(taskId);
	} catch (err) {
		// Merge call failed — park in needs_human(merge_blocked) so a human can
		// retry. Never leave the task stuck in merging.
		const reason = err instanceof Error ? err.message : String(err);
		await transitionTask(handle, log, {
			taskId,
			to: "needs_human",
			expectedFrom: "merging",
			actor: "auto_merge",
		});
		return { outcome: "needs_human", blocked: [`merge call failed: ${reason}`] };
	}

	// ── Confirm merge + unblock dependents ───────────────────────────────
	const confirm = await confirmMergeAndUnblock({ handle, log }, taskId, mergeSha);
	if (!confirm.ok) {
		return { outcome: "failed", reason: confirm.reason ?? "confirmMergeAndUnblock failed" };
	}

	return { outcome: "merged", mergeSha, unblocked: confirm.unblocked };
}
