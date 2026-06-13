/**
 * WHY: The §3.4 specialist-harness review round — an ALTERNATIVE to the single-judge
 * `runReviewRound` (review.ts). Selected per `config.review.specialistHarness`. Instead
 * of one reviewer producing a verdict, it fans the risk-tiered specialist FINDERS out in
 * parallel (`runReviewHarness`), coordinates their union, and maps the result back to the
 * canonical Verdict via `toVerdictShape`. Persistence + verdict-application (approve →
 * approved, revise → resume coder / escalate) mirror `runReviewRound` 1:1 so the rest of
 * the ping-pong loop is unchanged.
 *
 * It REUSES the existing ReviewDeps (thread / getDiff / resumeCoder / maxRounds) and adds
 * a `makeProduceFinder(task)` factory (the live specialist spawner from liveSpawn.ts) plus
 * an optional adversarial `verifyProducer`. The single-judge fields (engine/judge/
 * runReviewer) are ignored on this path.
 *
 * FAIL-CLOSED: a thrown harness (e.g. every finder spawn failed) escalates to needs_human —
 * never an approval. The harness itself already forces "block" when ALL finders fail (no
 * evidence ⇒ never approve), which maps to "revise" and, at max rounds, to needs_human.
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { TaskRow, FindingRow } from "../db/schema.ts";
import { eq, and } from "drizzle-orm";
import { tasks } from "../db/schema.ts";
import { getTask } from "../tasks/tasks.ts";
import { transitionTask } from "../tasks/transitions.ts";
import { enqueueWrite } from "../db/writer.ts";
import { hunkFor } from "../review/findings.ts";
import {
	runReviewHarness,
	toVerdictShape,
	type HarnessContext,
	type HarnessDeps,
} from "../review/harness.ts";
import {
	DEFAULT_MAX_ROUNDS,
	type ReviewDeps,
	type ReviewRoundOutcome,
} from "./review.ts";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/**
 * Reuses ReviewDeps (thread/getDiff/resumeCoder/maxRounds) and adds the live
 * specialist-finder spawner factory. `makeProduceFinder(task)` returns the
 * `produceFinder(kind, prompt) → stdout` the harness fans out (built per-task so
 * it can resolve the task's worktree/home). `verifyProducer` is the optional
 * adversarial verifier the coordinator applies to low-confidence findings.
 */
export type HarnessReviewDeps = ReviewDeps & {
	makeProduceFinder: (task: TaskRow) => HarnessDeps["produceFinder"];
	verifyProducer?: HarnessDeps["verifyProducer"];
};

// ---------------------------------------------------------------------------
// runHarnessReviewRound
// ---------------------------------------------------------------------------

/** Guards-and-bumps tasks.round inside the write queue (bookkeeping only). */
async function setTaskRound(handle: DbHandle, log: EventLog, taskId: number, round: number): Promise<void> {
	void log;
	await enqueueWrite(() => {
		handle.db
			.update(tasks)
			.set({ round, updatedAt: new Date().toISOString() })
			.where(and(eq(tasks.id, taskId)))
			.run();
	});
}

/**
 * Run ONE specialist-harness review round for `taskId` (§3.4). Same contract as
 * `runReviewRound`: the task must be in `review`; on approve → approved, on revise
 * → resume coder (round < maxRounds) else escalate to needs_human. Fail-closed: a
 * harness throw escalates; a forced "block" (zero evidence) is treated as "revise".
 */
export async function runHarnessReviewRound(
	deps: HarnessReviewDeps,
	taskId: number,
): Promise<ReviewRoundOutcome> {
	const { handle, log, thread } = deps;
	const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;

	// 1. Task must exist and be in review.
	const task = getTask(handle, taskId);
	if (task === null) {
		return { ok: false, reason: "task not found" };
	}
	if (task.state !== "review") {
		return { ok: false, reason: `task not in review (state=${task.state})` };
	}

	const r = task.round + 1;

	// 2. Current diff.
	const { diff, headSha, prTitle, prBody } = await deps.getDiff(task);

	// Helper: escalate to needs_human with a system thread event.
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

	// 3. Run the specialist harness over the diff (risk tier from the task).
	const ctx: HarnessContext = {
		prTitle,
		prBody,
		diff,
		round: r,
		declaredTier: task.riskTier,
	};
	let verdict;
	try {
		const result = await runReviewHarness(
			{
				produceFinder: deps.makeProduceFinder(task),
				...(deps.verifyProducer ? { verifyProducer: deps.verifyProducer } : {}),
			},
			ctx,
		);
		verdict = toVerdictShape(result);
	} catch (err) {
		// Every finder threw / harness crash → no evidence → escalate, never approve.
		return escalate(`harness review failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	// 4. Persist findings + verdict thread event. Finders are read-only, so the diff's
	// headSha is the anchoring commit (no per-run headSha to re-bind).
	const persistedFindings: FindingRow[] = [];
	for (const f of verdict.findings) {
		const row = await thread.addFinding(handle, {
			taskId,
			round: r,
			runId: null,
			severity: f.severity,
			confidence: f.confidence,
			commitSha: headSha,
			filePathOld: null,
			filePathNew: f.file,
			hunkContext: hunkFor(diff, f.file, f.line),
			description: f.description,
			suggestion: f.suggestion ?? null,
		});
		persistedFindings.push(row);
	}

	const findingIds = persistedFindings.map((f) => f.id);
	await thread.appendThreadEvent(handle, log, {
		taskId,
		kind: "verdict",
		actor: "reviewer:harness",
		round: r,
		idempotencyKey: `verdict:${taskId}:${r}:${headSha}`,
		payload: { verdict: verdict.verdict, summary: verdict.summary, headSha, findingIds },
	});

	// 5. Bump task.round.
	await setTaskRound(handle, log, taskId, r);

	// 6. Apply verdict.
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
