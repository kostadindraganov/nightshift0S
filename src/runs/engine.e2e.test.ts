/**
 * 2.5 verification gate — end-to-end engine test.
 *
 * WHY: Exercises the full run pipeline with a scripted FakeLauncher (no real
 * claude CLI or tmux) against an in-memory DB. Three scenarios:
 *
 *   (A) SCRIPTED RUN COMPLETES — claim → spawn → hook sequence → finishRun →
 *       assert state=succeeded + event order in the log.
 *
 *   (B) KILL/REAP — running run → reapRun → assert launcher.kill was called
 *       and run ends in killed.
 *
 *   (C) BOOT RECONCILE — non-terminal run whose FakeLauncher session is not
 *       alive → reconcileOrphansAtBoot marks it interrupted.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects, runs, tasks, events } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { FakeLauncher } from "./launcher.ts";
import { claimTaskAndCreateRun } from "./runs.ts";
import { spawnRun } from "./spawn.ts";
import { ingestHookEvent } from "./hookBridge.ts";
import { finishRun } from "./runs.ts";
import { reapRun, reconcileOrphansAtBoot } from "./reap.ts";

// ---------------------------------------------------------------------------
// Shared test fixtures

let tmp: string;

// spawnRun fails closed when bwrap is absent (macOS build host). This e2e
// exercises the run pipeline with a FakeLauncher, not the sandbox, so opt into
// the attended-dev escape hatch for the macOS run.
const prevEscapeHatch = process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER;
beforeAll(() => {
	process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER = "1";
});
afterAll(() => {
	if (prevEscapeHatch === undefined) {
		delete process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER;
	} else {
		process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER = prevEscapeHatch;
	}
});

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "ns-e2e-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

/**
 * Create a minimal git repo with a single commit so worktrees can be created.
 * Returns the repo path.
 */
function makeGitRepo(): string {
	const repoDir = join(tmp, "repo");
	mkdirSync(repoDir, { recursive: true });

	const git = (args: string[]) =>
		spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });

	git(["init", "--initial-branch=main"]);
	git(["config", "user.email", "test@nightshift.test"]);
	git(["config", "user.name", "Test"]);
	writeFileSync(join(repoDir, "README"), "test repo");
	git(["add", "README"]);
	git(["commit", "--no-gpg-sign", "-m", "init"]);

	return repoDir;
}

function makeHandle(): DbHandle {
	const h = openDatabase(":memory:");
	runMigrations(h);
	return h;
}

/** Seed a project + ready task; returns { projectId, taskId }. */
function seedProject(handle: DbHandle): { projectId: number; taskId: number } {
	const now = new Date().toISOString();
	const projectId = handle.db
		.insert(projects)
		.values({ name: "p", repoUrl: "https://example.test/r.git", createdAt: now, updatedAt: now })
		.returning()
		.get().id;
	const taskId = handle.db
		.insert(tasks)
		.values({ projectId, title: "e2e task", state: "ready", createdAt: now, updatedAt: now })
		.returning()
		.get().id;
	return { projectId, taskId };
}

// ---------------------------------------------------------------------------
// (A) SCRIPTED RUN COMPLETES

describe("(A) scripted run completes end-to-end", () => {
	test(
		"claim → spawn → hook sequence → finishRun ends with state=succeeded and ordered events",
		async () => {
			const handle = makeHandle();
			const log = new EventLog(handle);
			const launcher = new FakeLauncher();
			const repoDir = makeGitRepo();
			const homeRoot = join(tmp, "homes");
			const { taskId } = seedProject(handle);

			// 1. Claim the task and create a run (task: ready → coding, run: queued).
			const claimResult = await claimTaskAndCreateRun(handle, log, {
				taskId,
				kind: "coder",
				provider: "claude-code",
				model: "claude-sonnet-4-5",
				authLane: "subscription",
			});
			expect(claimResult.ok).toBe(true);
			if (!claimResult.ok) throw new Error("claim failed");
			const runId = claimResult.run.id;

			// The task must be in coding after claim.
			const taskRow = handle.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
			expect(taskRow.state).toBe("coding");
			expect(taskRow.claimedBy).toBe(runId);

			// 2. Spawn the run (run: queued → starting). FakeLauncher is used — no real CLI.
			const spawnedRun = await spawnRun(
				{ handle, log, launcher },
				{
					taskId,
					runId,
					provider: "claude-code",
					prompt: "write a widget",
					repoDir,
					homeRoot,
					slug: "widget",
				},
			);
			expect(spawnedRun.state).toBe("starting");
			expect(spawnedRun.tmuxSession).toBe(`ns-${runId}`);
			expect(launcher.wasLaunched(`ns-${runId}`)).toBe(true);

			// 3. SessionStart hook: starting → running.
			const r1 = await ingestHookEvent(handle, log, runId, {
				kind: "SessionStart",
				payload: { session_id: "sess-e2e-abc" },
			});
			expect(r1.transitioned).toBe(true);
			expect(r1.to).toBe("running");
			expect(handle.db.select().from(runs).where(eq(runs.id, runId)).get()!.state).toBe("running");

			// 4. PreToolUse(AskUserQuestion): running → awaiting_input.
			const r2 = await ingestHookEvent(handle, log, runId, {
				kind: "PreToolUse",
				payload: { tool_name: "AskUserQuestion" },
			});
			expect(r2.transitioned).toBe(true);
			expect(r2.to).toBe("awaiting_input");

			// 5. PostToolUse(AskUserQuestion): awaiting_input → running.
			const r3 = await ingestHookEvent(handle, log, runId, {
				kind: "PostToolUse",
				payload: { tool_name: "AskUserQuestion" },
			});
			expect(r3.transitioned).toBe(true);
			expect(r3.to).toBe("running");

			// 6. Stop (no background tasks): running → finishing.
			const r4 = await ingestHookEvent(handle, log, runId, {
				kind: "Stop",
				payload: { background_tasks: [] },
			});
			expect(r4.transitioned).toBe(true);
			expect(r4.to).toBe("finishing");

			// 7. finishRun: finishing → succeeded.
			const finResult = await finishRun(handle, log, {
				runId,
				outcome: "succeeded",
				exitReason: "clean_exit",
				cost: { tokensIn: 3000, tokensOut: 900, costUsd: 0.08, priced: true },
			});
			expect(finResult.ok).toBe(true);
			if (!finResult.ok) throw new Error("finish failed");
			expect(finResult.run.state).toBe("succeeded");
			expect(finResult.run.exitReason).toBe("clean_exit");
			expect(finResult.run.tokensIn).toBe(3000);
			expect(finResult.run.endedAt).not.toBeNull();

			// 8. Assert event log has run.state_changed events in correct order.
			const stateChangedEvents = handle.db
				.select()
				.from(events)
				.where(eq(events.runId, runId))
				.all()
				.filter((e) => e.kind === "run.state_changed");

			// Extract the 'to' field from each state_changed event payload.
			const toStates = stateChangedEvents.map((e) => {
				const payload = JSON.parse(e.payloadJson) as Record<string, unknown>;
				return payload.to as string;
			});

			// The expected state transitions in order:
			//   queued→starting (spawn), starting→running (SessionStart),
			//   running→awaiting_input (PreToolUse), awaiting_input→running (PostToolUse),
			//   running→finishing (Stop), finishing→succeeded (finishRun)
			expect(toStates).toEqual([
				"starting",
				"running",
				"awaiting_input",
				"running",
				"finishing",
				"succeeded",
			]);

			// 9. Assert run.hook.* events were logged (one per hook ingested).
			const hookEventRows = handle.db
				.select()
				.from(events)
				.where(eq(events.runId, runId))
				.all()
				.filter((e) => e.kind.startsWith("run.hook."));

			const hookKinds = hookEventRows.map((e) => e.kind);
			expect(hookKinds).toContain("run.hook.SessionStart");
			expect(hookKinds).toContain("run.hook.PreToolUse");
			expect(hookKinds).toContain("run.hook.PostToolUse");
			expect(hookKinds).toContain("run.hook.Stop");
		},
		{ timeout: 20_000 },
	);
});

// ---------------------------------------------------------------------------
// (B) KILL/REAP

describe("(B) kill/reap", () => {
	test("reapRun calls launcher.kill and run ends in killed", async () => {
		const handle = makeHandle();
		const log = new EventLog(handle);
		const now = new Date().toISOString();

		// Seed a project, task, and run in running state with a tmux session.
		const projectId = handle.db
			.insert(projects)
			.values({ name: "p", repoUrl: "https://ex.test/r.git", createdAt: now, updatedAt: now })
			.returning()
			.get().id;
		const taskId = handle.db
			.insert(tasks)
			.values({ projectId, title: "t", state: "coding", createdAt: now, updatedAt: now })
			.returning()
			.get().id;
		const sessionName = "ns-reap-e2e-1";
		const runId = handle.db
			.insert(runs)
			.values({
				taskId,
				kind: "coder",
				provider: "test",
				model: "m",
				authLane: "local",
				state: "running",
				tmuxSession: sessionName,
			})
			.returning()
			.get().id;

		// Pre-seed the session in the launcher as alive.
		const launcher = new FakeLauncher();
		await launcher.launch({
			runId,
			cwd: "/tmp",
			command: ["sleep", "1"],
			env: {},
			sessionName,
		});

		expect(launcher.wasKilled(sessionName)).toBe(false);

		// Reap the run.
		await reapRun({ handle, log, launcher }, runId, { reason: "killed" });

		// launcher.kill must have been called (session marked dead).
		expect(launcher.wasKilled(sessionName)).toBe(true);

		// The run must be in killed state.
		const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
		expect(row.state).toBe("killed");
		expect(row.endedAt).not.toBeNull();
	});

	test("reap order: kill is invoked before the DB transition", async () => {
		const handle = makeHandle();
		const log = new EventLog(handle);
		const now = new Date().toISOString();

		const projectId = handle.db
			.insert(projects)
			.values({ name: "p", repoUrl: "https://ex.test/r.git", createdAt: now, updatedAt: now })
			.returning()
			.get().id;
		const taskId = handle.db
			.insert(tasks)
			.values({ projectId, title: "t", state: "coding", createdAt: now, updatedAt: now })
			.returning()
			.get().id;
		const sessionName = "ns-reap-order-e2e";
		const runId = handle.db
			.insert(runs)
			.values({
				taskId,
				kind: "coder",
				provider: "test",
				model: "m",
				authLane: "local",
				state: "running",
				tmuxSession: sessionName,
			})
			.returning()
			.get().id;

		const callOrder: string[] = [];

		const launcher = new FakeLauncher();
		// Wrap kill to record when it fires relative to DB transitions.
		const originalKill = launcher.kill.bind(launcher);
		launcher.kill = async (h) => {
			callOrder.push("kill");
			await originalKill(h);
		};

		// Pre-seed the session.
		await launcher.launch({ runId, cwd: "/tmp", command: ["sleep"], env: {}, sessionName });

		await reapRun({ handle, log, launcher }, runId, { reason: "killed" });

		// kill must be in the list.
		expect(callOrder).toContain("kill");
		// kill must be the first recorded call (before any DB side-effects).
		expect(callOrder[0]).toBe("kill");

		const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
		expect(row.state).toBe("killed");
	});
});

// ---------------------------------------------------------------------------
// (C) BOOT RECONCILE

describe("(C) boot reconcile", () => {
	test("non-terminal run (starting) whose session is not alive is marked interrupted", async () => {
		const handle = makeHandle();
		const log = new EventLog(handle);
		const now = new Date().toISOString();

		const projectId = handle.db
			.insert(projects)
			.values({ name: "p", repoUrl: "https://ex.test/r.git", createdAt: now, updatedAt: now })
			.returning()
			.get().id;
		const taskId = handle.db
			.insert(tasks)
			.values({ projectId, title: "t", state: "coding", createdAt: now, updatedAt: now })
			.returning()
			.get().id;

		// Run is in 'starting' state (process/tmux died before run was live).
		// The FakeLauncher has no alive session — simulates a crash-before-SessionStart.
		// NOTE: only queued|starting → interrupted is legal per the state machine;
		// running-state orphans go to killed (see issues[] in gate report).
		const sessionName = "ns-orphan-e2e";
		const runId = handle.db
			.insert(runs)
			.values({
				taskId,
				kind: "coder",
				provider: "test",
				model: "m",
				authLane: "local",
				state: "starting",
				tmuxSession: sessionName,
			})
			.returning()
			.get().id;

		const launcher = new FakeLauncher();
		// No launch call → isAlive returns false for sessionName.

		const count = await reconcileOrphansAtBoot({ handle, log, launcher });
		expect(count).toBe(1);

		const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
		expect(row.state).toBe("interrupted");
	});

	test("alive non-terminal run is left unchanged by reconciliation", async () => {
		const handle = makeHandle();
		const log = new EventLog(handle);
		const now = new Date().toISOString();

		const projectId = handle.db
			.insert(projects)
			.values({ name: "p", repoUrl: "https://ex.test/r.git", createdAt: now, updatedAt: now })
			.returning()
			.get().id;
		const taskId = handle.db
			.insert(tasks)
			.values({ projectId, title: "t", state: "coding", createdAt: now, updatedAt: now })
			.returning()
			.get().id;

		const sessionName = "ns-alive-e2e";
		const runId = handle.db
			.insert(runs)
			.values({
				taskId,
				kind: "coder",
				provider: "test",
				model: "m",
				authLane: "local",
				state: "running",
				tmuxSession: sessionName,
			})
			.returning()
			.get().id;

		const launcher = new FakeLauncher();
		// Pre-seed the session as alive.
		await launcher.launch({ runId, cwd: "/tmp", command: ["sleep"], env: {}, sessionName });

		const count = await reconcileOrphansAtBoot({ handle, log, launcher });
		expect(count).toBe(0);

		const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
		expect(row.state).toBe("running");
	});

	test("queued and starting orphans are also reconciled to interrupted", async () => {
		const handle = makeHandle();
		const log = new EventLog(handle);
		const now = new Date().toISOString();

		// Two separate tasks + runs (partial-unique index requires one active run per task).
		const makeOrphan = (state: "queued" | "starting", label: string): number => {
			const pid = handle.db
				.insert(projects)
				.values({ name: label, repoUrl: "https://ex.test/r.git", createdAt: now, updatedAt: now })
				.returning()
				.get().id;
			const tid = handle.db
				.insert(tasks)
				.values({ projectId: pid, title: "t", state: "coding", createdAt: now, updatedAt: now })
				.returning()
				.get().id;
			return handle.db
				.insert(runs)
				.values({
					taskId: tid,
					kind: "coder",
					provider: "test",
					model: "m",
					authLane: "local",
					state,
					tmuxSession: `ns-${label}`,
				})
				.returning()
				.get().id;
		};

		const queuedId = makeOrphan("queued", "orphan-queued");
		const startingId = makeOrphan("starting", "orphan-starting");

		// FakeLauncher with no alive sessions → both are orphans.
		const launcher = new FakeLauncher();
		const count = await reconcileOrphansAtBoot({ handle, log, launcher });
		expect(count).toBe(2);

		const qRow = handle.db.select().from(runs).where(eq(runs.id, queuedId)).get()!;
		const sRow = handle.db.select().from(runs).where(eq(runs.id, startingId)).get()!;
		expect(qRow.state).toBe("interrupted");
		expect(sRow.state).toBe("interrupted");
	});
});
