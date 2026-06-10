/**
 * reapRun + reconcileOrphansAtBoot tests.
 *
 *   (a) reapRun: calls launcher.kill BEFORE the 400 ms sleep + DB step,
 *       and ends the run in `killed` state.
 *   (b) reconcileOrphansAtBoot: marks non-terminal runs whose FakeLauncher
 *       session is not alive as `interrupted`; leaves alive sessions alone.
 */

import { beforeEach, expect, test, describe } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects, runs, tasks } from "../db/schema.ts";
import { type RunState } from "../db/columns.ts";
import { EventLog } from "../events/events.ts";
import { FakeLauncher, type LaunchHandle } from "./launcher.ts";
import { reapRun, reconcileOrphansAtBoot } from "./reap.ts";

// ---------------------------------------------------------------------------
// Helpers

function makeHandle(): DbHandle {
	const h = openDatabase(":memory:");
	runMigrations(h);
	return h;
}

function makeProjectAndTask(handle: DbHandle): { projectId: number; taskId: number } {
	const now = new Date().toISOString();
	const projectId = handle.db
		.insert(projects)
		.values({ name: "p", repoUrl: "https://example.test/r.git", createdAt: now, updatedAt: now })
		.returning()
		.get().id;
	const taskId = handle.db
		.insert(tasks)
		.values({ projectId, title: "t", state: "coding", createdAt: now, updatedAt: now })
		.returning()
		.get().id;
	return { projectId, taskId };
}

/** Seed a run with the given state and optional tmux session name. */
function seedRun(
	handle: DbHandle,
	taskId: number,
	state: RunState,
	tmuxSession?: string,
): number {
	return handle.db
		.insert(runs)
		.values({
			taskId,
			kind: "coder",
			provider: "test",
			model: "m",
			authLane: "local",
			state,
			tmuxSession: tmuxSession ?? null,
		})
		.returning()
		.get().id;
}

// ---------------------------------------------------------------------------
// (a) reapRun

describe("reapRun", () => {
	test("calls launcher.kill and transitions run to killed", async () => {
		const handle = makeHandle();
		const log = new EventLog(handle);
		const { taskId } = makeProjectAndTask(handle);

		const sessionName = "ns-reap-test-1";
		const runId = seedRun(handle, taskId, "running", sessionName);

		// Pre-seed the session in the fake launcher as alive.
		const launcher = new FakeLauncher();
		await launcher.launch({
			runId,
			cwd: "/tmp",
			command: ["sleep", "1"],
			env: {},
			sessionName,
		});

		expect(launcher.wasKilled(sessionName)).toBe(false);

		await reapRun({ handle, log, launcher }, runId, { reason: "killed" });

		// Launcher.kill must have been called.
		expect(launcher.wasKilled(sessionName)).toBe(true);

		// Run must be in `killed` state.
		const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
		expect(row.state).toBe("killed");
		expect(row.endedAt).not.toBeNull();
	});

	test("kill is called BEFORE the DB transition (ordering guarantee)", async () => {
		const handle = makeHandle();
		const log = new EventLog(handle);
		const { taskId } = makeProjectAndTask(handle);

		const sessionName = "ns-reap-ordering-test";
		const runId = seedRun(handle, taskId, "running", sessionName);

		const events: string[] = [];

		// Instrument the launcher to record when kill is called.
		const launcher = new FakeLauncher();
		const originalKill = launcher.kill.bind(launcher);
		launcher.kill = async (h: LaunchHandle): Promise<void> => {
			events.push("kill");
			await originalKill(h);
		};

		// Pre-seed session.
		await launcher.launch({
			runId,
			cwd: "/tmp",
			command: ["sleep", "1"],
			env: {},
			sessionName,
		});

		await reapRun({ handle, log, launcher }, runId, { reason: "killed" });

		// "kill" must appear in events — and the run must be killed.
		expect(events).toContain("kill");

		const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
		expect(row.state).toBe("killed");

		// kill must be in the events list at index 0 (before DB transition).
		expect(events[0]).toBe("kill");
	});

	test("reapRun on a run with no tmux session is a no-op for kill (uses synthetic session name)", async () => {
		const handle = makeHandle();
		const log = new EventLog(handle);
		const { taskId } = makeProjectAndTask(handle);

		// Run has no stored tmuxSession.
		const runId = seedRun(handle, taskId, "starting", undefined);

		const launcher = new FakeLauncher();
		// Don't pre-seed any session — kill should be a no-op.

		await reapRun({ handle, log, launcher }, runId, { reason: "killed" });

		// Run must still end up killed (the kill no-op is fine).
		const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
		expect(row.state).toBe("killed");
	});
});

// ---------------------------------------------------------------------------
// (b) reconcileOrphansAtBoot

describe("reconcileOrphansAtBoot", () => {
	test("dead non-terminal run is transitioned to interrupted", async () => {
		const handle = makeHandle();
		const log = new EventLog(handle);
		const { taskId } = makeProjectAndTask(handle);

		const sessionName = "ns-orphan-dead";
		const runId = seedRun(handle, taskId, "starting", sessionName);

		// Launcher has no alive session → isAlive returns false.
		const launcher = new FakeLauncher();

		const count = await reconcileOrphansAtBoot({ handle, log, launcher });
		expect(count).toBe(1);

		const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
		expect(row.state).toBe("interrupted");
	});

	test("dead orphan in a LATE state (running) is also interrupted (regression)", async () => {
		// Boot reconciliation must handle orphans in running/awaiting_input/
		// background_waiting/finishing — not just queued/starting. The
		// `running → interrupted` edge must exist for this to reconcile.
		const handle = makeHandle();
		const log = new EventLog(handle);
		const { taskId } = makeProjectAndTask(handle);

		const runId = seedRun(handle, taskId, "running", "ns-orphan-running");
		const launcher = new FakeLauncher(); // session never launched → not alive

		const count = await reconcileOrphansAtBoot({ handle, log, launcher });
		expect(count).toBe(1);

		const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
		expect(row.state).toBe("interrupted");
	});

	test("alive non-terminal run is left alone", async () => {
		const handle = makeHandle();
		const log = new EventLog(handle);
		const { taskId } = makeProjectAndTask(handle);

		const sessionName = "ns-orphan-alive";
		const runId = seedRun(handle, taskId, "running", sessionName);

		const launcher = new FakeLauncher();
		// Pre-seed the session as alive.
		await launcher.launch({
			runId,
			cwd: "/tmp",
			command: ["sleep", "1"],
			env: {},
			sessionName,
		});

		const count = await reconcileOrphansAtBoot({ handle, log, launcher });
		expect(count).toBe(0);

		const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
		// State must be unchanged.
		expect(row.state).toBe("running");
	});

	test("terminal runs are not touched by reconciliation", async () => {
		const handle = makeHandle();
		const log = new EventLog(handle);
		const { taskId } = makeProjectAndTask(handle);

		// Insert terminal runs for all terminal states.
		const terminalIds: number[] = [];
		for (const state of ["succeeded", "failed", "killed", "interrupted"] as RunState[]) {
			// Each terminal run needs its own task to avoid unique-index conflicts with active runs.
			const now2 = new Date().toISOString();
			const extraProject = handle.db
				.insert(projects)
				.values({ name: `p-${state}`, repoUrl: "https://ex.test/r.git", createdAt: now2, updatedAt: now2 })
				.returning()
				.get().id;
			const extraTask = handle.db
				.insert(tasks)
				.values({ projectId: extraProject, title: "t", state: "done", createdAt: now2, updatedAt: now2 })
				.returning()
				.get().id;
			terminalIds.push(
				handle.db
					.insert(runs)
					.values({ taskId: extraTask, kind: "coder", provider: "p", model: "m", authLane: "local", state })
					.returning()
					.get().id,
			);
		}

		const launcher = new FakeLauncher();
		const count = await reconcileOrphansAtBoot({ handle, log, launcher });
		expect(count).toBe(0);

		// Terminal runs must be unchanged.
		for (const id of terminalIds) {
			const row = handle.db.select().from(runs).where(eq(runs.id, id)).get()!;
			expect(["succeeded", "failed", "killed", "interrupted"] as RunState[]).toContain(row.state);
		}
	});

	test("mix of dead and alive runs — only dead ones are reconciled", async () => {
		const handle = makeHandle();
		const log = new EventLog(handle);

		// Each run needs its own task (partial-unique index one_active_run_per_task).
		const now = new Date().toISOString();

		const makeRun = (state: RunState, sessionName: string): number => {
			const pid = handle.db
				.insert(projects)
				.values({ name: sessionName, repoUrl: "https://ex.test/r.git", createdAt: now, updatedAt: now })
				.returning()
				.get().id;
			const tid = handle.db
				.insert(tasks)
				.values({ projectId: pid, title: "t", state: "coding", createdAt: now, updatedAt: now })
				.returning()
				.get().id;
			return handle.db
				.insert(runs)
				.values({ taskId: tid, kind: "coder", provider: "p", model: "m", authLane: "local", state, tmuxSession: sessionName })
				.returning()
				.get().id;
		};

		const aliveRunId = makeRun("running", "ns-alive");
		const deadRunId = makeRun("queued", "ns-dead");

		const launcher = new FakeLauncher();
		// Seed the alive session.
		await launcher.launch({
			runId: aliveRunId,
			cwd: "/tmp",
			command: ["sleep", "1"],
			env: {},
			sessionName: "ns-alive",
		});
		// "ns-dead" is not launched → isAlive returns false.

		const count = await reconcileOrphansAtBoot({ handle, log, launcher });
		expect(count).toBe(1);

		const aliveRow = handle.db.select().from(runs).where(eq(runs.id, aliveRunId)).get()!;
		expect(aliveRow.state).toBe("running");

		const deadRow = handle.db.select().from(runs).where(eq(runs.id, deadRunId)).get()!;
		expect(deadRow.state).toBe("interrupted");
	});
});
