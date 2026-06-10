/**
 * Run state machine tests.
 *
 *   (a) Full legality matrix: every from→to pair of the 10 run states is
 *       attempted; exactly the spec-allowed set succeeds, everything else is
 *       rejected as illegal — each success emits exactly one run.state_changed
 *       event with the right payload.
 *   (b) Lost race: two concurrent transitionRun to the same target — exactly
 *       one ok, the other lost_race.
 *   (c) Terminal states have no outgoing edges.
 *   (d) Extra fields land on the row (sessionId on starting→running,
 *       exitReason+priced on finishing→succeeded).
 *   (e) startedAt set on queued→starting; endedAt set on any terminal.
 */

import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import { RUN_STATES, RUN_TERMINAL_STATES, type RunState } from "../db/columns.ts";
import { runMigrations } from "../db/migrate.ts";
import { events, runs } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import {
	isTerminalRunState,
	RUN_STATE_CHANGED,
	RUN_TRANSITIONS,
	transitionRun,
} from "./transitions.ts";

/**
 * Expected legal edges, transcribed BY HAND from SPEC-STATE-MACHINES §2 —
 * NOT derived from RUN_TRANSITIONS so the test catches drift.
 */
// Boot reconciliation makes `interrupted` reachable from EVERY non-terminal
// state (SPEC §2 prose), not just queued/starting.
const SPEC_ALLOWED: Record<RunState, readonly RunState[]> = {
	queued: ["starting", "interrupted", "killed"],
	starting: ["running", "interrupted", "killed"],
	running: ["awaiting_input", "background_waiting", "finishing", "succeeded", "failed", "interrupted", "killed"],
	awaiting_input: ["running", "interrupted", "killed"],
	background_waiting: ["running", "finishing", "interrupted", "killed"],
	finishing: ["succeeded", "failed", "interrupted", "killed"],
	// Terminal — no outgoing edges.
	succeeded: [],
	failed: [],
	killed: [],
	interrupted: [],
};

let handle: DbHandle;
let log: EventLog;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
});

/** Insert a run row directly at an arbitrary state (bypasses service). */
function seedRun(state: RunState): number {
	return handle.db
		.insert(runs)
		.values({ kind: "coder", provider: "test", model: "m", authLane: "local", state })
		.returning()
		.get().id;
}

function stateChangeEvents(runId: number) {
	return handle.db
		.select()
		.from(events)
		.where(eq(events.runId, runId))
		.all()
		.filter((e) => e.kind === RUN_STATE_CHANGED);
}

// ---------------------------------------------------------------------------
// (a) Legality matrix

test("implementation table covers exactly the spec-allowed pairs", () => {
	const implPairs = new Set(RUN_TRANSITIONS.map((t) => `${t.from}→${t.to}`));
	const specPairs = new Set(
		RUN_STATES.flatMap((from) => SPEC_ALLOWED[from].map((to) => `${from}→${to}`)),
	);
	expect([...implPairs].sort()).toEqual([...specPairs].sort());
});

test("full matrix: exactly the spec-allowed transitions succeed, each with one event row", async () => {
	const mismatches: string[] = [];

	for (const from of RUN_STATES) {
		for (const to of RUN_STATES) {
			const runId = seedRun(from);
			const allowed = SPEC_ALLOWED[from].includes(to);

			const result = await transitionRun(handle, log, {
				runId,
				to,
				actor: "test",
			});

			if (result.ok !== allowed) {
				mismatches.push(
					`${from}→${to}: expected ${allowed ? "legal" : "illegal"}, got ${JSON.stringify(result)}`,
				);
				continue;
			}

			const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
			const evs = stateChangeEvents(runId);

			if (allowed) {
				if (row.state !== to) mismatches.push(`${from}→${to}: row state is ${row.state}`);
				if (evs.length !== 1) mismatches.push(`${from}→${to}: ${evs.length} event rows`);
				else {
					const payload = JSON.parse(evs[0]!.payloadJson) as Record<string, unknown>;
					if (payload.from !== from || payload.to !== to || payload.actor !== "test") {
						mismatches.push(`${from}→${to}: bad payload ${evs[0]!.payloadJson}`);
					}
				}
			} else {
				if (!result.ok && result.reason !== "illegal") {
					mismatches.push(`${from}→${to}: rejected as ${result.reason}, not illegal`);
				}
				if (row.state !== from) mismatches.push(`${from}→${to}: illegal pair mutated state`);
				if (evs.length !== 0) mismatches.push(`${from}→${to}: illegal pair emitted events`);
			}
		}
	}

	expect(mismatches).toEqual([]);
});

// ---------------------------------------------------------------------------
// (b) Lost race

test("lost race: two concurrent transitionRun to same target — exactly one ok, other lost_race", async () => {
	const runId = seedRun("running");

	const [a, b] = await Promise.all([
		transitionRun(handle, log, { runId, to: "finishing", expectedFrom: "running", actor: "actor-1" }),
		transitionRun(handle, log, { runId, to: "finishing", expectedFrom: "running", actor: "actor-2" }),
	]);

	const winners = [a, b].filter((r) => r.ok);
	const losers = [a, b].filter((r) => !r.ok);
	expect(winners).toHaveLength(1);
	expect(losers).toHaveLength(1);
	expect(losers[0]).toEqual({ ok: false, reason: "lost_race" });

	// Invariant 5: exactly one state change → exactly one event row.
	expect(stateChangeEvents(runId)).toHaveLength(1);
	const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
	expect(row.state).toBe("finishing");
});

// ---------------------------------------------------------------------------
// (c) Terminal states have no outgoing edges

test("terminal states have no outgoing edges in the transition table", () => {
	for (const terminal of RUN_TERMINAL_STATES) {
		const outgoing = RUN_TRANSITIONS.filter((t) => t.from === terminal);
		expect(outgoing).toHaveLength(0);
	}
});

test("transitionRun from a terminal state is always illegal", async () => {
	for (const terminal of RUN_TERMINAL_STATES) {
		for (const to of RUN_STATES) {
			const runId = seedRun(terminal);
			const result = await transitionRun(handle, log, { runId, to, actor: "test" });
			// Terminal → anything is always illegal (no edge in the table).
			// Some transitions from terminal might not exist at all, and even if
			// the target state equals the current state there is no self-loop.
			expect(result.ok).toBe(false);
		}
	}
});

// ---------------------------------------------------------------------------
// (d) Extra fields land on the row

test("starting→running sets sessionId on the row", async () => {
	const runId = seedRun("starting");
	const result = await transitionRun(handle, log, {
		runId,
		to: "running",
		actor: "hook",
		extra: { sessionId: "sess-abc123" },
	});
	expect(result.ok).toBe(true);
	const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
	expect(row.sessionId).toBe("sess-abc123");
});

test("finishing→succeeded sets exitReason and priced on the row", async () => {
	const runId = seedRun("finishing");
	const result = await transitionRun(handle, log, {
		runId,
		to: "succeeded",
		actor: "hook",
		extra: {
			exitReason: "normal_exit",
			tokensIn: 1000,
			tokensOut: 500,
			costUsd: 0.025,
			priced: true,
		},
	});
	expect(result.ok).toBe(true);
	const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
	expect(row.exitReason).toBe("normal_exit");
	expect(row.tokensIn).toBe(1000);
	expect(row.tokensOut).toBe(500);
	expect(row.costUsd).toBeCloseTo(0.025);
	expect(row.priced).toBe(true);
});

test("finishing→failed sets exitReason on the row", async () => {
	const runId = seedRun("finishing");
	const result = await transitionRun(handle, log, {
		runId,
		to: "failed",
		actor: "hook",
		extra: { exitReason: "api_error", priced: false },
	});
	expect(result.ok).toBe(true);
	const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
	expect(row.exitReason).toBe("api_error");
	expect(row.priced).toBe(false);
});

// ---------------------------------------------------------------------------
// (e) Timestamps

test("queued→starting sets startedAt", async () => {
	const runId = seedRun("queued");
	const result = await transitionRun(handle, log, {
		runId,
		to: "starting",
		actor: "scheduler",
		extra: { tmuxSession: "ns-1234", worktreePath: "/tmp/wt/1", homePath: "/tmp/home/1" },
	});
	expect(result.ok).toBe(true);
	const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
	expect(row.startedAt).not.toBeNull();
	expect(row.tmuxSession).toBe("ns-1234");
	expect(row.worktreePath).toBe("/tmp/wt/1");
	expect(row.homePath).toBe("/tmp/home/1");
});

test("terminal transitions set endedAt", async () => {
	for (const terminal of RUN_TERMINAL_STATES) {
		// Find a valid source state for this terminal.
		const edge = RUN_TRANSITIONS.find((t) => t.to === terminal);
		if (!edge) continue; // interrupted/killed have multiple sources, just pick one.
		const runId = seedRun(edge.from);
		const result = await transitionRun(handle, log, { runId, to: terminal, actor: "test" });
		expect(result.ok).toBe(true);
		const row = handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
		expect(row.endedAt).not.toBeNull();
	}
});

// ---------------------------------------------------------------------------
// Edge cases

test("missing run → not_found", async () => {
	const result = await transitionRun(handle, log, { runId: 999_999, to: "starting", actor: "t" });
	expect(result).toEqual({ ok: false, reason: "not_found" });
});

test("isTerminalRunState correctly identifies terminal states", () => {
	for (const s of RUN_STATES) {
		const expected = (["succeeded", "failed", "killed", "interrupted"] as RunState[]).includes(s);
		expect(isTerminalRunState(s)).toBe(expected);
	}
});
