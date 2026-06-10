/**
 * Run reaper + boot-time orphan reconciliation (task 2.5).
 *
 * `reapRun` implements the REAP ORDER from the spec:
 *   1. Kill the tmux session (covers the provider CLI via kill-session SIGHUP).
 *   2. Sleep 400 ms (let the OS reap file handles and tmpfs writes).
 *   3. Leave the worktree in place (ADR-0004: removal is always explicit).
 *   4. Transition the run → killed via the state machine.
 *
 * `reconcileOrphansAtBoot` runs once at startup: any run in a non-terminal
 * state whose tmux session is no longer alive is transitioned to `interrupted`
 * (SPEC §2 prose — "every run in a non-terminal state whose tmux session is
 * gone → interrupted"; distinct from `killed`, which means we reaped it).
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import { RUN_TERMINAL_STATES, type RunState } from "../db/columns.ts";
import { runs } from "../db/schema.ts";
import { transitionRun, isTerminalRunState } from "./transitions.ts";
import type { Launcher, LaunchHandle } from "./launcher.ts";

// ---------------------------------------------------------------------------
// Deps shape (mirrors spawn.ts pattern)

export interface ReapDeps {
	handle: DbHandle;
	log: EventLog;
	launcher: Launcher;
}

// ---------------------------------------------------------------------------
// reapRun

export interface ReapOptions {
	reason: "killed";
}

/**
 * Reap a run in SPEC-ORDER:
 *   1. Kill tmux session (covers provider CLI via SIGHUP).
 *   2. Sleep 400 ms.
 *   3. Leave worktree (ADR-0004).
 *   4. Transition run → killed.
 *
 * Steps are executed unconditionally: even if the session is already dead,
 * we still sleep and update the DB so the caller always gets a consistent
 * terminal state.
 */
export async function reapRun(
	deps: ReapDeps,
	runId: number,
	_opts: ReapOptions,
): Promise<void> {
	const { handle, log, launcher } = deps;

	// Fetch the current run row to find its tmux session name.
	const { eq } = await import("drizzle-orm");
	const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get();

	// Step 1: kill tmux session.  We build a handle from the stored session name
	// (or a synthetic one so the kill path is always invoked and idempotent).
	const sessionName = row?.tmuxSession ?? `ns-${runId}`;
	const launchHandle: LaunchHandle = { sessionName };
	await launcher.kill(launchHandle).catch(() => undefined);

	// Step 2: 400 ms grace period.
	await new Promise<void>((resolve) => setTimeout(resolve, 400));

	// Step 3: worktree left in place (ADR-0004, removal is always explicit).

	// Step 4: transition run → killed.
	await transitionRun(handle, log, {
		runId,
		to: "killed",
		actor: "reaper",
	});
}

// ---------------------------------------------------------------------------
// reconcileOrphansAtBoot

/**
 * At startup, scan every non-terminal run. If its tmux session is no longer
 * alive, transition it to `interrupted` — legal from ANY non-terminal state
 * via the "any active → interrupted" reconciliation edges (SPEC §2 prose).
 * `interrupted` (vanished across a restart) is deliberately distinct from
 * `killed` (we reaped it) and `failed` (it errored).
 *
 * Returns the count of runs that were reconciled.
 */
export async function reconcileOrphansAtBoot(deps: ReapDeps): Promise<number> {
	const { handle, log, launcher } = deps;
	const { eq, notInArray } = await import("drizzle-orm");

	// Fetch all non-terminal runs.
	const nonTerminal = handle.db
		.select()
		.from(runs)
		.where(notInArray(runs.state, [...RUN_TERMINAL_STATES] as RunState[]))
		.all();

	let reconciled = 0;

	for (const run of nonTerminal) {
		// Build a LaunchHandle from the stored session name.
		const sessionName = run.tmuxSession ?? `ns-${run.id}`;
		const launchHandle: LaunchHandle = { sessionName };

		const alive = await launcher.isAlive(launchHandle).catch(() => false);
		if (alive) continue;

		// Dead non-terminal run → interrupted.
		const result = await transitionRun(handle, log, {
			runId: run.id,
			to: "interrupted",
			expectedFrom: run.state,
			actor: "boot_reconcile",
		});

		if (result.ok) {
			reconciled += 1;
		}
		// If the transition lost a race (very unlikely at boot), skip silently.
	}

	return reconciled;
}
