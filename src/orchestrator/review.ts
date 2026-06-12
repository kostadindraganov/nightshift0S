/**
 * WHY: Drives the reviewer side of the coder↔reviewer ping-pong loop.
 * Owns one review round: spawn the reviewer, validate the verdict, persist
 * findings + resolutions + thread events, then apply the outcome (approve /
 * revise / escalate). Also handles human verdicts for tasks stuck in
 * needs_human. All side-effecting dependencies are injectable so this module
 * runs on macOS with fakes and no real LLM, git, or DB credentials.
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { TaskRow, FindingRow } from "../db/schema.ts";
import { getTask } from "../tasks/tasks.ts";
import { hunkFor } from "../review/findings.ts";
import { transitionTask } from "../tasks/transitions.ts";
import { enqueueWrite } from "../db/writer.ts";
import { tasks } from "../db/schema.ts";
import { eq, and } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Structural ports — local mirrors of §3.3 (B1) and §4.3/§4.4 (B2).
// Integration wires the real modules; the shapes MUST stay identical.
// ---------------------------------------------------------------------------

export interface AppendThreadEventInput {
	taskId: number;
	kind: "message" | "finding" | "rebuttal" | "verdict" | "system" | "human" | "artifact";
	actor: string;
	round: number;
	runId?: number | null;
	idempotencyKey?: string;
	payload: unknown;
	artifactRefs?: string[];
}

export interface AddFindingInput {
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
}

export interface UpdateFindingResolutionInput {
	findingId: number;
	resolutionState: "fixed" | "rebutted" | "withdrawn" | "accepted_risk";
	resolvedRound: number;
}

export interface ThreadPort {
	appendThreadEvent(handle: DbHandle, log: EventLog, input: AppendThreadEventInput): Promise<import("../db/schema.ts").ThreadEventRow>;
	getThread(handle: DbHandle, taskId: number): import("../db/schema.ts").ThreadEventRow[];
	addFinding(handle: DbHandle, input: AddFindingInput): Promise<FindingRow>;
	listFindings(handle: DbHandle, taskId: number, round?: number): FindingRow[];
	updateFindingResolution(handle: DbHandle, log: EventLog, input: UpdateFindingResolutionInput): Promise<FindingRow | null>;
}

export interface VerdictFinding {
	file: string;
	line?: number;
	severity: "critical" | "high" | "medium" | "low" | "nit";
	confidence: number;
	description: string;
	suggestion?: string;
}

export interface VerdictResolution {
	finding_id: number;
	state: "fixed" | "rebutted" | "withdrawn" | "accepted_risk";
}

export interface VerdictShape {
	verdict: "approved" | "revise";
	summary: string;
	findings: VerdictFinding[];
	resolutions?: VerdictResolution[];
}

export interface CodeReviewContextShape {
	prTitle: string;
	prBody: string;
	diff: string;
	round: number;
	priorFindings: FindingRow[];
}

export interface JudgePort {
	kind: "code_review" | "rubric" | "design";
	tag: string;
	buildPrompt(ctx: CodeReviewContextShape): string;
	parse(stdout: string): { ok: true; verdict: VerdictShape } | { ok: false; reason: string };
}

export type EnginePort = (
	judge: JudgePort,
	ctx: CodeReviewContextShape,
	produce: (prompt: string, attempt: number) => Promise<string>,
	opts?: { repairRetries?: number },
) => Promise<{ ok: true; verdict: VerdictShape } | { ok: false; reason: string }>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReviewerRunResult {
	stdout: string;
	runId: number;
	headSha: string;
	provider: string;
}

export interface ReviewDeps {
	handle: DbHandle;
	log: EventLog;
	thread: ThreadPort;
	engine: EnginePort;
	judge: JudgePort;
	/** Reads the current reviewable state of the task's PR/branch. INJECTED. */
	getDiff: (task: TaskRow) => Promise<{ diff: string; headSha: string; prTitle: string; prBody: string }>;
	/** Spawns/resumes ONE reviewer turn. Fake in tests. */
	runReviewer: (input: { task: TaskRow; round: number; prompt: string; attempt: number }) => Promise<ReviewerRunResult>;
	/** Resumes the coder session with the findings as the next turn. */
	resumeCoder: (input: { task: TaskRow; round: number; findings: FindingRow[] }) => Promise<{ runId: number }>;
	maxRounds?: number;
}

export const DEFAULT_MAX_ROUNDS = 4;

export type ReviewRoundOutcome =
	| { ok: true; outcome: "approved" | "revise" | "needs_human"; round: number }
	| { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Guards-and-bumps tasks.round inside the write queue. Bookkeeping only. */
async function setTaskRound(handle: DbHandle, taskId: number, round: number): Promise<void> {
	await enqueueWrite(() => {
		handle.db
			.update(tasks)
			.set({ round, updatedAt: new Date().toISOString() })
			.where(and(eq(tasks.id, taskId)))
			.run();
	});
}

/** Filter to findings that still need attention (open or rebutted). */
function unresolvedFilter(f: FindingRow): boolean {
	return f.resolutionState === "open" || f.resolutionState === "rebutted";
}

// ---------------------------------------------------------------------------
// runReviewRound
// ---------------------------------------------------------------------------

export async function runReviewRound(deps: ReviewDeps, taskId: number): Promise<ReviewRoundOutcome> {
	const { handle, log, thread, engine, judge } = deps;
	const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;

	// 1. Verify task exists and is in review state.
	const task = getTask(handle, taskId);
	if (task === null) {
		return { ok: false, reason: "task not found" };
	}
	if (task.state !== "review") {
		return { ok: false, reason: `task not in review (state=${task.state})` };
	}

	const r = task.round + 1;

	// 2. Fetch the current diff.
	const { diff, headSha, prTitle, prBody } = await deps.getDiff(task);

	// 3. Build context with prior unresolved findings.
	const allFindings = thread.listFindings(handle, taskId);
	const priorFindings = allFindings.filter(unresolvedFilter);
	const ctx: CodeReviewContextShape = { prTitle, prBody, diff, round: r, priorFindings };

	// 4. Run the engine; the producer closes over runReviewer, recording the last result.
	let lastResult: ReviewerRunResult | null = null;

	const engineResult = await engine(judge, ctx, async (prompt: string, attempt: number) => {
		const result = await deps.runReviewer({ task, round: r, prompt, attempt });
		lastResult = result;
		return result.stdout;
	});

	// Helper to escalate with a system thread event.
	async function escalate(reason: string): Promise<ReviewRoundOutcome> {
		await transitionTask(handle, log, {
			taskId,
			to: "needs_human",
			expectedFrom: "review",
			actor: "review_orchestrator",
		});
		await thread.appendThreadEvent(handle, log, {
			taskId,
			kind: "system",
			actor: "review_orchestrator",
			round: r,
			payload: { reason },
		});
		return { ok: true, outcome: "needs_human", round: r };
	}

	// 5. Engine failure → escalate; never approve.
	if (!engineResult.ok) {
		return escalate(engineResult.reason);
	}

	// 6. SHA binding: if the reviewer ran against a different HEAD, verdict invalid.
	if (lastResult === null || (lastResult as ReviewerRunResult).headSha !== headSha) {
		return escalate("head moved during review");
	}

	const result = lastResult as ReviewerRunResult;
	const verdict = engineResult.verdict;

	// 7. Persist findings, resolutions, and the verdict thread event.
	const persistedFindings: FindingRow[] = [];

	for (const f of verdict.findings) {
		const row = await thread.addFinding(handle, {
			taskId,
			round: r,
			runId: result.runId,
			severity: f.severity,
			confidence: f.confidence,
			commitSha: result.headSha,
			filePathOld: null,
			filePathNew: f.file,
			hunkContext: hunkFor(diff, f.file, f.line),
			description: f.description,
			suggestion: f.suggestion ?? null,
		});
		persistedFindings.push(row);
	}

	if (verdict.resolutions) {
		for (const res of verdict.resolutions) {
			await thread.updateFindingResolution(handle, log, {
				findingId: res.finding_id,
				resolutionState: res.state,
				resolvedRound: r,
			});
		}
	}

	const findingIds = persistedFindings.map((f) => f.id);
	await thread.appendThreadEvent(handle, log, {
		taskId,
		kind: "verdict",
		actor: `reviewer:${result.provider}`,
		round: r,
		runId: result.runId,
		idempotencyKey: `verdict:${taskId}:${r}:${result.headSha}`,
		payload: { verdict: verdict.verdict, summary: verdict.summary, headSha: result.headSha, findingIds },
	});

	// 8. Bump task.round.
	await setTaskRound(handle, taskId, r);

	// 9. Apply verdict.
	if (verdict.verdict === "approved") {
		const tr = await transitionTask(handle, log, {
			taskId,
			to: "approved",
			expectedFrom: "review",
			actor: "review_orchestrator",
		});
		if (!tr.ok) return { ok: false, reason: "lost_race" };
		return { ok: true, outcome: "approved", round: r };
	}

	// revise
	if (r < maxRounds) {
		await deps.resumeCoder({ task, round: r, findings: persistedFindings });
		await thread.appendThreadEvent(handle, log, {
			taskId,
			kind: "system",
			actor: "review_orchestrator",
			round: r,
			payload: { reason: `coder resumed, round ${r}` },
		});
		const tr = await transitionTask(handle, log, {
			taskId,
			to: "coding",
			expectedFrom: "review",
			actor: "review_orchestrator",
		});
		if (!tr.ok) return { ok: false, reason: "lost_race" };
		return { ok: true, outcome: "revise", round: r };
	}

	// revise but max rounds reached → escalate.
	return escalate("max rounds reached");
}

// ---------------------------------------------------------------------------
// applyHumanVerdict
// ---------------------------------------------------------------------------

export interface HumanVerdictInput {
	decision: "resume_coding" | "force_merge" | "reject";
	actor: string;
}

export async function applyHumanVerdict(
	deps: ReviewDeps,
	taskId: number,
	input: HumanVerdictInput,
): Promise<{ ok: true; task: TaskRow } | { ok: false; reason: string }> {
	const { handle, log, thread } = deps;

	const task = getTask(handle, taskId);
	if (task === null) {
		return { ok: false, reason: "task not found" };
	}
	if (task.state !== "needs_human") {
		return { ok: false, reason: `task not in needs_human (state=${task.state})` };
	}

	// Always write the audit record first (immutable).
	await thread.appendThreadEvent(handle, log, {
		taskId,
		kind: "human",
		actor: input.actor,
		round: task.round,
		idempotencyKey: `human:${taskId}:${input.decision}:${task.round}`,
		payload: { decision: input.decision, actor: input.actor },
	});

	if (input.decision === "resume_coding") {
		const tr = await transitionTask(handle, log, {
			taskId,
			to: "coding",
			expectedFrom: "needs_human",
			actor: input.actor,
		});
		if (!tr.ok) return { ok: false, reason: tr.reason };
		const allFindings = thread.listFindings(handle, taskId);
		const unresolved = allFindings.filter(unresolvedFilter);
		await deps.resumeCoder({ task, round: task.round, findings: unresolved });
		return { ok: true, task: tr.task };
	}

	if (input.decision === "force_merge") {
		const tr = await transitionTask(handle, log, {
			taskId,
			to: "merging",
			expectedFrom: "needs_human",
			actor: input.actor,
		});
		if (!tr.ok) return { ok: false, reason: tr.reason };
		return { ok: true, task: tr.task };
	}

	// reject → cancelled
	const tr = await transitionTask(handle, log, {
		taskId,
		to: "cancelled",
		expectedFrom: "needs_human",
		actor: input.actor,
	});
	if (!tr.ok) return { ok: false, reason: tr.reason };
	return { ok: true, task: tr.task };
}
