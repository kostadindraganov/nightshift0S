/**
 * WHY: Drives the plan-review phase of the spec-first flow (BLUEPRINT Phase 6,
 * §3.10 item 1). Runs BEFORE any coding: it checks a task's PLAN against its
 * acceptance criteria and records the verdict in the task thread so the
 * planner/coder can consume it. ADVISORY — it never changes the task state
 * machine (no transitionTask calls). FAIL-CLOSED: the only way to outcome
 * "approved" is a stdout that survives extract+validate; an engine failure can
 * only return {ok:false}, never a fabricated approval. All side-effecting
 * dependencies are injectable so this module is fully testable without spawning
 * real agents or touching a real DB.
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { TaskRow, FindingRow } from "../db/schema.ts";
import { getTask } from "../tasks/tasks.ts";
import type { PlanReviewContext } from "../review/planReviewJudge.ts";
import type { ValidateResult } from "../review/verdict.ts";

// ---------------------------------------------------------------------------
// Structural ports — mirrors the port pattern from orchestrator/review.ts.
// Integration wires the real modules; shapes must stay compatible.
// ---------------------------------------------------------------------------

/** Minimal subset of ThreadPort required by this orchestrator. */
export interface PlanThreadPort {
	appendThreadEvent(
		handle: DbHandle,
		log: EventLog,
		input: {
			taskId: number;
			kind: "message" | "finding" | "rebuttal" | "verdict" | "system" | "human" | "artifact";
			actor: string;
			round: number;
			runId?: number | null;
			idempotencyKey?: string;
			payload: unknown;
		},
	): Promise<unknown>;
	addFinding(
		handle: DbHandle,
		input: {
			taskId: number;
			round: number;
			runId?: number | null;
			severity: "critical" | "high" | "medium" | "low" | "nit";
			confidence: number;
			commitSha: string;
			filePathOld?: string | null;
			filePathNew?: string | null;
			hunkContext?: string | null;
			description: string;
			suggestion?: string | null;
		},
	): Promise<FindingRow>;
}

/** Plan-review judge port (structurally matches Judge<PlanReviewContext>). */
export interface PlanJudgePort {
	kind: string;
	tag: string;
	buildPrompt(ctx: PlanReviewContext): string;
	parse(stdout: string): ValidateResult;
}

/** Engine port: same signature as runVerdict, but typed for PlanJudgePort. */
export type PlanEnginePort = (
	judge: PlanJudgePort,
	ctx: PlanReviewContext,
	produce: (prompt: string, attempt: number) => Promise<string>,
	opts?: { repairRetries?: number },
) => Promise<{ ok: true; verdict: import("../review/verdict.ts").Verdict } | { ok: false; reason: string }>;

export interface PlanReviewerRunResult {
	stdout: string;
	runId: number;
	provider: string;
}

// ---------------------------------------------------------------------------
// PlanReviewDeps
// ---------------------------------------------------------------------------

export interface PlanReviewDeps {
	handle: DbHandle;
	log: EventLog;
	thread: PlanThreadPort;
	engine: PlanEnginePort;
	judge: PlanJudgePort;
	/** Reads the current plan for the task. Faked in tests; wired to live planner in prod. */
	getPlan(task: TaskRow): Promise<{ plan: string; headSha?: string }>;
	/** Spawns/resumes one plan-reviewer turn. Faked in tests. */
	runPlanReviewer(input: {
		task: TaskRow;
		round: number;
		prompt: string;
		attempt: number;
	}): Promise<PlanReviewerRunResult>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PlanReviewRoundOutcome =
	| { ok: true; outcome: "approved" | "revise"; round: number }
	| { ok: false; reason: string };

// ---------------------------------------------------------------------------
// runPlanReviewRound
// ---------------------------------------------------------------------------

/**
 * Run one plan-review round for the given task.
 *
 * 1. Load the task (fail-closed if missing).
 * 2. Fetch the plan via deps.getPlan.
 * 3. Build PlanReviewContext from task.title + task.acceptanceCriteria + plan.
 * 4. Run deps.engine with the judge; the producer closure calls deps.runPlanReviewer.
 * 5. On engine failure → {ok:false} — NEVER approved.
 * 6. Persist findings (one addFinding per finding in the verdict).
 * 7. Emit a "verdict" thread event (actor "plan_reviewer").
 * 8. Return {ok:true, outcome, round}.
 *
 * ADVISORY: does NOT call transitionTask. The verdict lives in the thread for
 * the planner/coder to consume; the task state machine is untouched.
 */
export async function runPlanReviewRound(
	deps: PlanReviewDeps,
	taskId: number,
): Promise<PlanReviewRoundOutcome> {
	const { handle, log, thread, engine, judge } = deps;

	// 1. Load task.
	const task = getTask(handle, taskId);
	if (task === null) {
		return { ok: false, reason: "task not found" };
	}

	const r = task.round + 1;

	// 2. Fetch the current plan.
	const { plan } = await deps.getPlan(task);

	// 3. Build context — acceptanceCriteria may be null in DB; treat null as empty.
	const ctx: PlanReviewContext = {
		taskTitle: task.title,
		acceptanceCriteria: task.acceptanceCriteria ?? "",
		plan,
		round: r,
	};

	// 4. Run engine; producer closure records the last run result.
	let lastResult: PlanReviewerRunResult | null = null;

	const engineResult = await engine(judge, ctx, async (prompt: string, attempt: number) => {
		const result = await deps.runPlanReviewer({ task, round: r, prompt, attempt });
		lastResult = result;
		return result.stdout;
	});

	// 5. Engine failure → fail-closed, never approved.
	if (!engineResult.ok) {
		return { ok: false, reason: engineResult.reason };
	}

	const result = lastResult as unknown as PlanReviewerRunResult;
	const verdict = engineResult.verdict;

	// 6. Persist findings.
	const persistedFindings: FindingRow[] = [];
	for (const f of verdict.findings) {
		const row = await thread.addFinding(handle, {
			taskId,
			round: r,
			runId: result.runId,
			severity: f.severity,
			confidence: f.confidence,
			// No real commit SHA at plan time; use a sentinel.
			commitSha: "plan",
			filePathOld: null,
			// "file" for a plan finding is a step/section label, not a real path.
			filePathNew: f.file,
			hunkContext: null,
			description: f.description,
			suggestion: f.suggestion ?? null,
		});
		persistedFindings.push(row);
	}

	const findingIds = persistedFindings.map((f) => f.id);

	// 7. Emit verdict thread event.
	await thread.appendThreadEvent(handle, log, {
		taskId,
		kind: "verdict",
		actor: "plan_reviewer",
		round: r,
		runId: result.runId,
		idempotencyKey: `plan_verdict:${taskId}:${r}`,
		payload: { verdict: verdict.verdict, summary: verdict.summary, findingIds },
	});

	// 8. Return outcome.
	return { ok: true, outcome: verdict.verdict, round: r };
}
