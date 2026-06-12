/**
 * WHY: Integration tests for runReviewRound + applyHumanVerdict using an
 * in-memory DB, real migrations, and in-memory fakes for thread/engine/judge.
 * Covers the critical invariants: ping-pong approval flow, fail-closed on
 * bad engine output, SHA mismatch escalation, max-rounds escalation, and
 * human force-merge audit trail.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects, tasks, findings, threadEvents } from "../db/schema.ts";
import type { FindingRow, ThreadEventRow } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { getTask } from "../tasks/tasks.ts";
import {
	runReviewRound,
	applyHumanVerdict,
	DEFAULT_MAX_ROUNDS,
	type ReviewDeps,
	type ThreadPort,
	type JudgePort,
	type EnginePort,
	type VerdictShape,
	type ReviewerRunResult,
	type AppendThreadEventInput,
	type AddFindingInput,
	type UpdateFindingResolutionInput,
} from "./review.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): { handle: DbHandle; log: EventLog } {
	const handle = openDatabase(":memory:");
	runMigrations(handle);
	const log = new EventLog(handle);
	return { handle, log };
}

function seedProject(handle: DbHandle): number {
	const now = new Date().toISOString();
	return handle.db
		.insert(projects)
		.values({ name: "p", repoUrl: "https://g.com/o/r.git", createdAt: now, updatedAt: now })
		.returning()
		.get().id;
}

function seedReviewTask(handle: DbHandle, projectId: number, round = 0): number {
	const now = new Date().toISOString();
	return handle.db
		.insert(tasks)
		.values({ projectId, title: "t", state: "review", priority: 0, round, createdAt: now, updatedAt: now })
		.returning()
		.get().id;
}

/** Minimal in-memory thread port — real enough for invariant testing. */
function makeMemoryThread(handle: DbHandle, _log: EventLog): ThreadPort {
	return {
		appendThreadEvent: async (_h, _l, input: AppendThreadEventInput) => {
			const now = new Date().toISOString();
			// Compute next seq by filtering JS-side (avoids SQL-syntax issues in tests).
			const existing = handle.db.select().from(threadEvents).all() as ThreadEventRow[];
			const taskRows = existing.filter((r) => r.taskId === input.taskId);
			const nextSeq = taskRows.length + 1;

			return handle.db
				.insert(threadEvents)
				.values({
					taskId: input.taskId,
					seq: nextSeq,
					kind: input.kind,
					actor: input.actor,
					round: input.round,
					runId: null,       // no real run row in tests; FK is nullable
					idempotencyKey: input.idempotencyKey ?? null,
					payloadJson: JSON.stringify(input.payload),
					redacted: false,
					createdAt: now,
				})
				.returning()
				.get();
		},
		getThread: (_h, taskId: number) => {
			return (handle.db.select().from(threadEvents).all() as ThreadEventRow[]).filter((r) => r.taskId === taskId);
		},
		addFinding: async (_h, input: AddFindingInput) => {
			return handle.db
				.insert(findings)
				.values({
					taskId: input.taskId,
					round: input.round,
					runId: null,       // no real run row in tests; FK is nullable
					severity: input.severity,
					confidence: input.confidence,
					commitSha: input.commitSha,
					filePathOld: input.filePathOld ?? null,
					filePathNew: input.filePathNew ?? null,
					hunkContext: input.hunkContext ?? null,
					description: input.description,
					suggestion: input.suggestion ?? null,
					resolutionState: "open",
				})
				.returning()
				.get();
		},
		listFindings: (_h, taskId: number, round?: number) => {
			const all = (handle.db.select().from(findings).all() as FindingRow[]).filter((r) => r.taskId === taskId);
			if (round !== undefined) return all.filter((r) => r.round === round);
			return all;
		},
		updateFindingResolution: async (_h, _l, input: UpdateFindingResolutionInput) => {
			const { eq, and, inArray } = await import("drizzle-orm");
			const updated = handle.db
				.update(findings)
				.set({ resolutionState: input.resolutionState, resolvedRound: input.resolvedRound })
				.where(
					and(
						eq(findings.id, input.findingId),
						inArray(findings.resolutionState, ["open", "rebutted"]),
					),
				)
				.returning()
				.get();
			return updated ?? null;
		},
	};
}

function makeScriptedJudge(tag = "output"): JudgePort {
	return {
		kind: "code_review",
		tag,
		buildPrompt: (_ctx) => "review prompt",
		parse: (stdout) => {
			try {
				const raw = JSON.parse(stdout) as unknown;
				return { ok: true, verdict: raw as VerdictShape };
			} catch {
				return { ok: false, reason: "parse error" };
			}
		},
	};
}

/** Engine that runs the scripted producer and passes stdout through judge.parse. */
const passthroughEngine: EnginePort = async (judge, ctx, produce, _opts) => {
	const stdout = await produce(judge.buildPrompt(ctx), 0);
	return judge.parse(stdout);
};

/** Engine that always fails after 1+repairRetries calls. */
function makeBadEngine(retries = 2): { engine: EnginePort; callCount: () => number } {
	let calls = 0;
	const engine: EnginePort = async (_judge, _ctx, produce, opts) => {
		const maxRetries = opts?.repairRetries ?? retries;
		for (let i = 0; i <= maxRetries; i++) {
			await produce("prompt", i);
			calls++;
		}
		return { ok: false, reason: "exhausted" };
	};
	return { engine, callCount: () => calls };
}

function makeDeps(
	handle: DbHandle,
	log: EventLog,
	overrides: Partial<ReviewDeps> & { engine?: EnginePort },
): ReviewDeps {
	const thread = makeMemoryThread(handle, log);
	return {
		handle,
		log,
		thread,
		engine: overrides.engine ?? passthroughEngine,
		judge: makeScriptedJudge(),
		getDiff: async (_task) => ({ diff: "+const x = 1;", headSha: "aaaa", prTitle: "PR", prBody: "" }),
		runReviewer: async ({ prompt }) => ({ stdout: prompt, runId: 1, headSha: "aaaa", provider: "claude-code" }),
		resumeCoder: async (_input) => ({ runId: 99 }),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runReviewRound", () => {
	let handle: DbHandle;
	let log: EventLog;
	let projectId: number;

	beforeEach(() => {
		({ handle, log } = makeDb());
		projectId = seedProject(handle);
	});

	// -------------------------------------------------------------------------
	// Test 1: ping-pong — revise round 1 → approved round 2
	// -------------------------------------------------------------------------
	test("ping-pong: round 1 revise + resumeCoder called → round 2 approved, 2 verdict events", async () => {
		const taskId = seedReviewTask(handle, projectId, 0);

		let coderResumed = false;
		let callCount = 0;

		// Engine scripted: call 1 → revise with 1 finding; call 2 → approved.
		const engine: EnginePort = async (judge, ctx, produce, _opts) => {
			callCount++;
			const stdout = await produce(judge.buildPrompt(ctx), 0);
			return judge.parse(stdout);
		};

		const verdicts = [
			JSON.stringify({ verdict: "revise", summary: "needs work", findings: [{ file: "a.ts", severity: "high", confidence: 0.9, description: "bug" }], resolutions: [] }),
			JSON.stringify({ verdict: "approved", summary: "looks good", findings: [], resolutions: [] }),
		];
		let verdictIdx = 0;

		const deps = makeDeps(handle, log, {
			engine,
			runReviewer: async ({ prompt: _p }) => ({
				stdout: verdicts[verdictIdx++] ?? "",
				runId: 10 + verdictIdx,
				headSha: "aaaa",
				provider: "codex",
			}),
			resumeCoder: async (_input) => {
				coderResumed = true;
				return { runId: 99 };
			},
		});

		// Round 1 — revise.
		const r1 = await runReviewRound(deps, taskId);
		expect(r1).toMatchObject({ ok: true, outcome: "revise", round: 1 });
		expect(coderResumed).toBe(true);

		// Task state after round 1: coding (transitioned back).
		const taskAfterR1 = getTask(handle, taskId);
		expect(taskAfterR1?.state).toBe("coding");
		expect(taskAfterR1?.round).toBe(1);

		// Round 2: transition task back to review manually (normally coder does it).
		handle.db.update(tasks).set({ state: "review" }).where(
			(await import("drizzle-orm")).eq(tasks.id, taskId),
		).run();

		const r2 = await runReviewRound(deps, taskId);
		expect(r2).toMatchObject({ ok: true, outcome: "approved", round: 2 });

		const taskAfterR2 = getTask(handle, taskId);
		expect(taskAfterR2?.state).toBe("approved");
		expect(taskAfterR2?.round).toBe(2);

		// Two verdict thread events.
		const verdictEvents = deps.thread
			.getThread(handle, taskId)
			.filter((e) => e.kind === "verdict");
		expect(verdictEvents).toHaveLength(2);

		// One finding from round 1.
		const allFindings = deps.thread.listFindings(handle, taskId);
		expect(allFindings).toHaveLength(1);
		expect(allFindings[0]?.round).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Test 2: engine fails → needs_human, never approved
	// -------------------------------------------------------------------------
	test("engine exhausted → needs_human, outcome is never approved", async () => {
		const taskId = seedReviewTask(handle, projectId, 0);
		const { engine } = makeBadEngine(2);

		const deps = makeDeps(handle, log, {
			engine,
			runReviewer: async (_input) => ({
				stdout: "garbage not json",
				runId: 5,
				headSha: "aaaa",
				provider: "codex",
			}),
		});

		const result = await runReviewRound(deps, taskId);
		expect(result).toMatchObject({ ok: true, outcome: "needs_human" });
		// task must NOT be approved.
		const task = getTask(handle, taskId);
		expect(task?.state).toBe("needs_human");
		expect(task?.state).not.toBe("approved");
	});

	// -------------------------------------------------------------------------
	// Test 3: headSha mismatch → needs_human
	// -------------------------------------------------------------------------
	test("headSha mismatch between getDiff and reviewer → needs_human", async () => {
		const taskId = seedReviewTask(handle, projectId, 0);

		const deps = makeDeps(handle, log, {
			getDiff: async (_task) => ({ diff: "+x", headSha: "aaaa", prTitle: "PR", prBody: "" }),
			runReviewer: async (_input) => ({
				stdout: JSON.stringify({ verdict: "approved", summary: "ok", findings: [], resolutions: [] }),
				runId: 7,
				headSha: "bbbb",   // DIFFERENT from getDiff's headSha
				provider: "codex",
			}),
		});

		const result = await runReviewRound(deps, taskId);
		expect(result).toMatchObject({ ok: true, outcome: "needs_human" });
		const task = getTask(handle, taskId);
		expect(task?.state).toBe("needs_human");
	});

	// -------------------------------------------------------------------------
	// Test 4: revise at r >= maxRounds → needs_human
	// -------------------------------------------------------------------------
	test("revise at r >= maxRounds → needs_human not coding", async () => {
		// Seed at round = maxRounds - 1 so next round = maxRounds.
		const taskId = seedReviewTask(handle, projectId, DEFAULT_MAX_ROUNDS - 1);

		const deps = makeDeps(handle, log, {
			runReviewer: async (_input) => ({
				stdout: JSON.stringify({ verdict: "revise", summary: "still broken", findings: [], resolutions: [] }),
				runId: 8,
				headSha: "aaaa",
				provider: "codex",
			}),
		});

		const result = await runReviewRound(deps, taskId);
		expect(result).toMatchObject({ ok: true, outcome: "needs_human", round: DEFAULT_MAX_ROUNDS });
		const task = getTask(handle, taskId);
		expect(task?.state).toBe("needs_human");
	});

	// -------------------------------------------------------------------------
	// Test 5: applyHumanVerdict force_merge → merging + audit event
	// -------------------------------------------------------------------------
	test("applyHumanVerdict force_merge → state merging, audit human thread event written", async () => {
		// Seed task directly in needs_human.
		const now = new Date().toISOString();
		const taskId = handle.db
			.insert(tasks)
			.values({ projectId, title: "stuck", state: "needs_human", priority: 0, round: 2, createdAt: now, updatedAt: now })
			.returning()
			.get().id;

		const thread = makeMemoryThread(handle, log);
		const deps: ReviewDeps = {
			handle,
			log,
			thread,
			engine: passthroughEngine,
			judge: makeScriptedJudge(),
			getDiff: async (_t) => ({ diff: "", headSha: "x", prTitle: "", prBody: "" }),
			runReviewer: async (_i) => ({ stdout: "", runId: 0, headSha: "x", provider: "p" }),
			resumeCoder: async (_i) => ({ runId: 0 }),
		};

		const result = await applyHumanVerdict(deps, taskId, {
			decision: "force_merge",
			actor: "human:alice",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.task.state).toBe("merging");
		}

		// Audit thread event must exist.
		const humanEvents = thread
			.getThread(handle, taskId)
			.filter((e) => e.kind === "human");
		expect(humanEvents).toHaveLength(1);
		const payload = JSON.parse(humanEvents[0]?.payloadJson ?? "{}") as { decision: string };
		expect(payload.decision).toBe("force_merge");
	});
});
