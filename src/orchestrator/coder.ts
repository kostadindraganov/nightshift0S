/**
 * WHY: Wires already-built component services into the autonomous coder loop
 * so a task flows: coding (run succeeded) → gate checks → forge push/PR →
 * coding→review (or coding→needs_human on any gate block). A separate
 * confirmMergeAndUnblock step does merging→done(+merge_sha) then unblocks
 * dependents via recomputeReadiness.
 *
 * All side-effecting dependencies are injectable so this module is testable
 * on macOS with fakes — no real git remote, CI service, or GitHub token needed.
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { TaskRow, RunRow } from "../db/schema.ts";
import { getTask } from "../tasks/tasks.ts";
import { transitionTask } from "../tasks/transitions.ts";
import { recomputeReadiness } from "../tasks/dependencies.ts";
import { getRun } from "../runs/runs.ts";
import { claimTaskAndCreateRun } from "../runs/runs.ts";
import { transitionRun } from "../runs/transitions.ts";
import { spawnRun } from "../runs/spawn.ts";
import type { SpawnDeps } from "../runs/spawn.ts";
import type { AuthLane, RunKind } from "../db/columns.ts";
import type { NightshiftConfig } from "../config/config.ts";
import { prepareAndOpenPR } from "../forge/forge.ts";
import type { ForgeClient } from "../forge/github.ts";
import type { Pusher } from "../forge/push.ts";
import { prePrGate } from "../gate/gate.ts";
import type { CiClient } from "../gate/ci.ts";
import type { GitRunner } from "../gate/freshness.ts";
import { execGit } from "../worktree/git.ts";
import { assertEgressOrRefuse, egressActive } from "../egress/guard.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RepoConfig {
	repoDir: string;
	worktreePath: string;
	remoteUrl: string;
	owner: string;
	repo: string;
	defaultBranch: string;
	requiredChecks?: string[];
}

export interface CoderOrchestratorDeps {
	handle: DbHandle;
	log: EventLog;
	forgeClient: ForgeClient;
	pusher?: Pusher;
	ci?: CiClient;
	git?: GitRunner;
	resolveRepo: (task: TaskRow, run: RunRow) => RepoConfig;
}

export type CoderOutcome =
	| { outcome: "review"; pr: { number: number; url: string } }
	| { outcome: "needs_human"; blocked: string[] }
	| { outcome: "failed"; reason: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Escalate a task from `coding` to `needs_human` via the state machine
 * (`coding → needs_human`, trigger "gate_blocked"). Used when the coder run
 * succeeded but a pre-PR gate blocked. A lost race (another actor moved the
 * task) is tolerated — the transition is a no-op and we still report the block.
 */
async function parkTask(
	handle: DbHandle,
	log: EventLog,
	taskId: number,
): Promise<void> {
	await transitionTask(handle, log, {
		taskId,
		to: "needs_human",
		expectedFrom: "coding",
		actor: "orchestrator",
	});
}

// ---------------------------------------------------------------------------
// completeCoderRun
// ---------------------------------------------------------------------------

/**
 * Called after a coder run exits. Reads the run + task, runs the pre-PR gate
 * (branch freshness + CI), calls prepareAndOpenPR (secret scan + push + open
 * PR), then transitions the task coding→review. Any hard-block transitions to
 * coding→needs_human instead.
 */
export async function completeCoderRun(
	deps: CoderOrchestratorDeps,
	runId: number,
): Promise<CoderOutcome> {
	const { handle, log } = deps;

	// 1. Resolve run.
	const run = getRun(handle, runId);
	if (run === null) {
		return { outcome: "failed", reason: "run not found" };
	}

	// 2. Resolve task (taskId may be null for utility runs — treat as missing).
	if (run.taskId === null || run.taskId === undefined) {
		return { outcome: "failed", reason: "run has no associated task" };
	}
	const task = getTask(handle, run.taskId);
	if (task === null) {
		return { outcome: "failed", reason: "task not found" };
	}

	// 3. Handle failed run — transition task coding→failed and return.
	if (run.state === "failed") {
		await transitionTask(handle, log, {
			taskId: task.id,
			to: "failed",
			expectedFrom: "coding",
			actor: "orchestrator",
		});
		return { outcome: "failed", reason: "coder run failed" };
	}

	// 4. Require run to be in succeeded state before proceeding.
	if (run.state !== "succeeded") {
		return { outcome: "failed", reason: `run not succeeded (state=${run.state})` };
	}

	// 5. Resolve repo config and git runner.
	const cfg = deps.resolveRepo(task, run);
	const git: GitRunner = deps.git ?? execGit;

	// 6. Resolve headSha from the worktree HEAD.
	const headSha = (await git(["rev-parse", "HEAD"], cfg.worktreePath)).trim();

	// 7. Require a recorded baseSha — without it we cannot assess branch freshness.
	const baseSha = task.baseSha;
	if (baseSha === null || baseSha === undefined || baseSha === "") {
		await parkTask(handle, log, task.id);
		return { outcome: "needs_human", blocked: ["no base SHA recorded"] };
	}

	// 8. Compute diff (empty diff is allowed — do not special-case).
	const diff = await git(["diff", `${baseSha}..HEAD`], cfg.worktreePath);

	// 9. Pre-PR gate: freshness + CI.
	const gate = await prePrGate(
		{ git: deps.git, ci: deps.ci },
		{
			repoDir: cfg.repoDir,
			baseSha,
			defaultBranch: cfg.defaultBranch,
			headRef: task.branch ?? headSha,
			requiredChecks: cfg.requiredChecks,
		},
	);

	if (!gate.pass) {
		await parkTask(handle, log, task.id);
		return { outcome: "needs_human", blocked: gate.blocked };
	}

	// 10. Forge: secret scan + push + open PR.
	const forge = await prepareAndOpenPR(
		{ git: deps.git, pusher: deps.pusher, client: deps.forgeClient },
		{
			repoDir: cfg.repoDir,
			worktreePath: cfg.worktreePath,
			branch: task.branch ?? `ns/${task.id}`,
			baseSha,
			headSha,
			remoteUrl: cfg.remoteUrl,
			owner: cfg.owner,
			repo: cfg.repo,
			defaultBranch: cfg.defaultBranch,
			diff,
			title: `[ns#${task.id}] ${task.title}`,
			body: `Automated PR for task ${task.id}.`,
		},
	);

	if (!forge.ok) {
		await parkTask(handle, log, task.id);
		return { outcome: "needs_human", blocked: forge.blocked };
	}

	// 11. Transition coding→review — guard against a concurrent actor.
	const reviewTransition = await transitionTask(handle, log, {
		taskId: task.id,
		to: "review",
		expectedFrom: "coding",
		actor: "orchestrator",
	});

	if (!reviewTransition.ok) {
		return { outcome: "failed", reason: "task moved during review handoff" };
	}

	// 12. Emit task.pr_opened event.
	await deps.log.emitEvent({
		projectId: task.projectId,
		taskId: task.id,
		runId,
		kind: "task.pr_opened",
		payload: { taskId: task.id, pr: forge.pr },
	});

	return { outcome: "review", pr: forge.pr };
}

// ---------------------------------------------------------------------------
// confirmMergeAndUnblock
// ---------------------------------------------------------------------------

/**
 * Called when the forge webhook confirms a merge. Transitions the task
 * merging→done (recording the merge SHA) and promotes any now-unblocked
 * dependent tasks from backlog→ready via recomputeReadiness.
 */
export async function confirmMergeAndUnblock(
	deps: { handle: DbHandle; log: EventLog },
	taskId: number,
	mergeSha: string,
): Promise<{ ok: boolean; reason?: string; unblocked: number[] }> {
	const { handle, log } = deps;

	// 1. Task must exist and be in merging.
	const task = getTask(handle, taskId);
	if (task === null) {
		return { ok: false, reason: "task not found", unblocked: [] };
	}
	if (task.state !== "merging") {
		return {
			ok: false,
			reason: `task not in merging (state=${task.state})`,
			unblocked: [],
		};
	}

	// 2. Transition merging→done with the confirmed merge SHA.
	const result = await transitionTask(handle, log, {
		taskId,
		to: "done",
		expectedFrom: "merging",
		actor: "forge_merge",
		extra: { mergeSha },
	});

	if (!result.ok) {
		return { ok: false, reason: result.reason, unblocked: [] };
	}

	// 3. Recompute readiness — promote backlog tasks whose deps are now all merged.
	const promoted = await recomputeReadiness(handle, log, task.projectId);
	return { ok: true, unblocked: promoted.map((t) => t.id) };
}

// ---------------------------------------------------------------------------
// startCoderTask (optional convenience wrapper)
// ---------------------------------------------------------------------------

export interface StartCoderTaskInput {
	taskId: number;
	provider: string;
	model: string;
	authLane: AuthLane;
	prompt: string;
	repoDir: string;
	homeRoot: string;
	/** Blueprint workflow-skill slugs mounted into the per-task HOME before launch. */
	skillsMount?: string[];
	/**
	 * V3 container isolation policy (config.container), threaded through to
	 * spawnRun → makeIsolatedSpawn. Absent or disabled (enabled=false) leaves the
	 * default bwrap sandbox path unchanged.
	 */
	containerConfig?: NightshiftConfig["container"];
	/**
	 * True for any non-human-initiated spawn (scheduler/webhook). When true the
	 * egress fail-closed gate is enforced before any run row or agent process is
	 * created (LIVE-WIRING D5, THREAT-MODEL fail-closed requirement #2).
	 * Defaults to false (human-initiated/attended) for backwards compatibility.
	 */
	unattended?: boolean;
	/**
	 * Whether the operator has explicitly trusted this repo
	 * (`config.sandbox.unattendedUntrustedRepos`). Only consulted for unattended
	 * spawns. Defaults to false (untrusted).
	 */
	trustedRepo?: boolean;
}

/**
 * Convenience wrapper: atomically claims a ready task (ready→coding + run
 * creation) and then spawns the run. Returns {ok:false} if the claim fails.
 *
 * EGRESS FAIL-CLOSED (LIVE-WIRING D5): for an unattended spawn on an untrusted
 * repo, refuse before creating any run/agent unless nftables egress control is
 * active. `assertEgressOrRefuse` throws `EgressInactiveError` in that case; we
 * let it propagate so the scheduler/webhook caller sees the refusal.
 */
export async function startCoderTask(
	deps: SpawnDeps,
	input: StartCoderTaskInput,
	/**
	 * Injectable probes so the egress gate is testable without nftables. The
	 * default probe is the real `egressActive()`; tests pass a deterministic one.
	 */
	probes: { egressActive: () => Promise<boolean> } = { egressActive },
): Promise<{ ok: true; run: RunRow } | { ok: false; reason: string }> {
	const { handle, log } = deps;

	// Egress gate — checked at the single run-start chokepoint, BEFORE the claim
	// so no run row or agent process is created when the gate refuses.
	assertEgressOrRefuse({
		egressActive: await probes.egressActive(),
		unattended: input.unattended ?? false,
		trustedRepo: input.trustedRepo ?? false,
	});

	// Compute baseSha — the HEAD of the main repo at claim time. The orchestrator
	// uses this to diff the worktree and verify freshness after the run completes.
	let baseSha: string | undefined;
	try {
		baseSha = (await execGit(["rev-parse", "HEAD"], input.repoDir)).trim();
	} catch {
		// Non-fatal: the orchestrator will parkTask if baseSha is missing.
	}

	// Claim the task and create the run.
	const claim = await claimTaskAndCreateRun(handle, log, {
		taskId: input.taskId,
		kind: "coder" as RunKind,
		provider: input.provider,
		model: input.model,
		authLane: input.authLane,
		baseSha,
	});

	if (!claim.ok) {
		return { ok: false, reason: claim.reason };
	}

	// Spawn the run (worktree, home dir, launch). The claim above already moved
	// the task ready→coding and inserted a queued run; spawnRun can throw on a
	// worktree/launcher/sandbox failure or a lost queued→starting race, all of
	// which leave the run non-terminal ('queued') and the task stuck in 'coding'
	// — a zombie that permanently occupies a scheduler slot AND the provider cap.
	// Roll BOTH back on any throw so the slot/cap are freed and the existing
	// failed→backlog triage/requeue path can re-attempt the task.
	let run: RunRow;
	try {
		run = await spawnRun(deps, {
			taskId: input.taskId,
			runId: claim.run.id,
			provider: input.provider,
			prompt: input.prompt,
			repoDir: input.repoDir,
			homeRoot: input.homeRoot,
			skillsMount: input.skillsMount,
			containerConfig: input.containerConfig,
		});
	} catch (err) {
		// Log spawn failures so operators can diagnose them from journalctl.
		console.error(`[spawn_rollback] run ${claim.run.id} task ${input.taskId}:`, err instanceof Error ? err.message : String(err));
		// (1) Run → killed from ANY active state (no expectedFrom: spawnRun may
		// have advanced it queued→starting before failing the post-launch race).
		await transitionRun(handle, log, {
			runId: claim.run.id,
			to: "killed",
			actor: "spawn_rollback",
		});
		// (2) Task coding→failed so the failed→backlog demote/triage path requeues
		// it. A lost race (another actor already moved the task) is a tolerated no-op.
		await transitionTask(handle, log, {
			taskId: input.taskId,
			to: "failed",
			expectedFrom: "coding",
			actor: "spawn_rollback",
		});
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}

	return { ok: true, run };
}
