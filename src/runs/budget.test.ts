/**
 * Budget enforcement tests — hermetic, all deps injected (PHASE5A §4.2 list).
 *
 * WHY: the wall-clock kill is the real overnight enforcement and the cost kill
 * must fail-closed on unproven telemetry; each case pins one branch so a
 * regression is caught with no live infrastructure (fake clock, fake kill).
 *
 * Cases (≤5):
 *   (a) wall-clock kill fires just past the limit and calls the injected kill.
 *   (b) priced=false NEVER cost-kills even over the cap.
 *   (c) priced=true + hardCostUsdPerRun set → cost kill.
 *   (d) advisory warns ONCE (second sweep is silent) and never kills.
 *   (e) a fresh run → none.
 */

import { beforeEach, expect, test } from "bun:test";
import { openDatabase } from "../db/client.ts";
import type { DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { runs, events } from "../db/schema.ts";
import type { RunRow } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { evaluateRunBudget, makeBudgetEnforcer } from "./budget.ts";
import type { BudgetDeps } from "./budget.ts";

// ---------------------------------------------------------------------------
// Helpers

let handle: DbHandle;
let log: EventLog;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
});

/** Seed a run directly into the DB in the given state. */
function seedRun(
	overrides: Partial<{
		state: RunRow["state"];
		startedAt: string | null;
		tokensIn: number | null;
		tokensOut: number | null;
		costUsd: number | null;
		priced: boolean;
	}> = {},
): RunRow {
	const now = new Date().toISOString();
	return handle.db
		.insert(runs)
		.values({
			kind: "coder",
			provider: "test",
			model: "test-model",
			authLane: "subscription",
			state: overrides.state ?? "running",
			startedAt: overrides.startedAt !== undefined ? overrides.startedAt : now,
			tokensIn: overrides.tokensIn ?? null,
			tokensOut: overrides.tokensOut ?? null,
			costUsd: overrides.costUsd ?? null,
			priced: overrides.priced ?? false,
		})
		.returning()
		.get();
}

/** A BudgetDeps with a recording fake kill and a fixed clock. */
function makeDeps(
	nowMs: number,
	killed: number[],
	over: Partial<Pick<BudgetDeps, "wallClockSecondsPerRun" | "advisoryTokensPerRun" | "hardCostUsdPerRun">> = {},
): BudgetDeps {
	return {
		handle,
		log,
		now: () => nowMs,
		wallClockSecondsPerRun: over.wallClockSecondsPerRun ?? 3600,
		advisoryTokensPerRun: over.advisoryTokensPerRun ?? 200_000,
		hardCostUsdPerRun: over.hardCostUsdPerRun ?? 0,
		kill: async (runId: number) => {
			killed.push(runId);
		},
	};
}

function eventsOfKind(kind: string) {
	return handle.db.select().from(events).all().filter((e) => e.kind === kind);
}

// ---------------------------------------------------------------------------
// (a) wall-clock kill fires just past the limit + calls injected kill

test("(a) wall-clock kill fires past the limit and calls injected kill", async () => {
	const startedAt = new Date(1_000_000).toISOString();
	const run = seedRun({ startedAt });
	const killed: number[] = [];
	// 3600 s budget; now = started + 3601 s → exceeded.
	const deps = makeDeps(1_000_000 + 3_601_000, killed);

	const decision = evaluateRunBudget(deps, run, false);
	expect(decision.action).toBe("kill_wall_clock");
	expect(decision.timeout?.name).toBe("wall_clock_budget");

	const did = await makeBudgetEnforcer(deps).sweep();
	expect(did.map((d) => d.action)).toEqual(["kill_wall_clock"]);
	expect(killed).toEqual([run.id]);
	// Audit row exists (emitted BEFORE the kill).
	expect(eventsOfKind("run.budget_kill")).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// (b) priced=false NEVER cost-kills, even over the cap

test("(b) priced=false never cost-kills even over the cost cap", async () => {
	const run = seedRun({ priced: false, costUsd: 999 });
	const killed: number[] = [];
	const deps = makeDeps(Date.parse(run.startedAt!) + 1_000, killed, {
		hardCostUsdPerRun: 1,
	});

	const decision = evaluateRunBudget(deps, run, false);
	expect(decision.action).toBe("none");

	await makeBudgetEnforcer(deps).sweep();
	expect(killed).toEqual([]);
	expect(eventsOfKind("run.budget_kill")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// (c) priced=true + hard cost cap → cost kill

test("(c) priced=true + hardCostUsdPerRun → cost kill", async () => {
	const run = seedRun({ priced: true, costUsd: 5 });
	const killed: number[] = [];
	const deps = makeDeps(Date.parse(run.startedAt!) + 1_000, killed, {
		hardCostUsdPerRun: 1,
	});

	const decision = evaluateRunBudget(deps, run, false);
	expect(decision.action).toBe("kill_cost");
	expect(decision.timeout?.name).toBe("cost_budget");

	const did = await makeBudgetEnforcer(deps).sweep();
	expect(did.map((d) => d.action)).toEqual(["kill_cost"]);
	expect(killed).toEqual([run.id]);
});

// ---------------------------------------------------------------------------
// (d) advisory warns once (second sweep silent), never kills

test("(d) advisory warns once and never kills", async () => {
	const run = seedRun({ tokensIn: 150_000, tokensOut: 80_000, priced: false }); // 230k > 200k
	const killed: number[] = [];
	const deps = makeDeps(Date.parse(run.startedAt!) + 1_000, killed);
	const enforcer = makeBudgetEnforcer(deps);

	const first = await enforcer.sweep();
	expect(first.map((d) => d.action)).toEqual(["warn_advisory"]);
	expect(killed).toEqual([]); // advisory never kills
	expect(eventsOfKind("run.budget_advisory")).toHaveLength(1);

	// Second sweep on the SAME enforcer: already warned → silent.
	const second = await enforcer.sweep();
	expect(second).toEqual([]);
	expect(eventsOfKind("run.budget_advisory")).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// (e) fresh run → none

test("(e) fresh run within all budgets → none", async () => {
	const run = seedRun({ tokensIn: 10, tokensOut: 10, priced: false });
	const killed: number[] = [];
	const deps = makeDeps(Date.parse(run.startedAt!) + 60_000, killed);

	expect(evaluateRunBudget(deps, run, false).action).toBe("none");
	const did = await makeBudgetEnforcer(deps).sweep();
	expect(did).toEqual([]);
	expect(killed).toEqual([]);
});
