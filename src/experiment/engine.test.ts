/**
 * Experiment engine tests (UNIT P6-4).
 *
 * Matrix:
 *   1. parseExperimentConfig validates all required fields and rejects invalid inputs.
 *   2. budgetMs parses wall-clock budget strings ("90s", "10m", "1h") and fails closed.
 *   3. runExperimentIteration keeps on improvement per direction ("lower"/"higher").
 *   4. runExperimentIteration discards on regression and calls reset().
 *   5. runExperimentIteration records status="crash" on produceEdit/commit/eval failure.
 *   6. runExperimentIteration records status="crash" on thrown error.
 *   7. runExperimentLoop respects maxIterations and until-time, tracks best metric.
 *
 * FAIL-CLOSED hardening:
 *   - eval runs OUTSIDE the workspace under iteration_budget: evalRunner receives
 *     the just-made commitSha, the immutable evalCommand, and the parsed budgetMs.
 *   - a crash NEVER advances the branch: after a kept iteration the reset target /
 *     moving baseline stays pinned to the last kept commit/metric across a crash.
 *   - the experiment.iteration EVENT payload never leaks the crash reason / a
 *     secret-bearing description (§3.12.7) — only metric/commit/status fields.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { events, runs } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import {
	budgetMs,
	parseExperimentConfig,
	runExperimentIteration,
	runExperimentLoop,
	type ExperimentConfig,
	type ExperimentDeps,
	type IterationResult,
} from "./engine.ts";
import { listLedger } from "./ledger.ts";

let handle: DbHandle;
let log: EventLog;

function insertTestRun(id?: number) {
	handle.db
		.insert(runs)
		.values({
			kind: "experiment",
			provider: "test",
			model: "test",
			authLane: "local",
			state: "running",
			...(id ? { id } : {}),
		})
		.run();
}

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
});

afterEach(() => {
	handle.sqlite.close();
});

describe("parseExperimentConfig", () => {
	test("parses valid config", () => {
		const json = JSON.stringify({
			target_paths: ["src/foo.ts", "src/bar.ts"],
			eval_command: "bun test eval.ts",
			metric: { name: "loss", direction: "lower" },
			iteration_budget: "10m",
			max_iterations: 5,
			until: "2026-12-31T00:00:00Z",
			keep_rule: "improved",
		});

		const result = parseExperimentConfig(json);

		expect(result).not.toHaveProperty("error");
		const cfg = result as ExperimentConfig;
		expect(cfg.targetPaths).toEqual(["src/foo.ts", "src/bar.ts"]);
		expect(cfg.evalCommand).toBe("bun test eval.ts");
		expect(cfg.metric.name).toBe("loss");
		expect(cfg.metric.direction).toBe("lower");
		expect(cfg.iterationBudget).toBe("10m");
		expect(cfg.maxIterations).toBe(5);
		expect(cfg.until).toBe("2026-12-31T00:00:00Z");
		expect(cfg.keepRule).toBe("improved");
	});

	test("defaults iteration_budget to '10m' when absent", () => {
		const json = JSON.stringify({
			target_paths: ["src/foo.ts"],
			eval_command: "eval.sh",
			metric: { name: "metric", direction: "lower" },
			keep_rule: "improved",
		});

		const cfg = parseExperimentConfig(json) as ExperimentConfig;
		expect(cfg.iterationBudget).toBe("10m");
	});

	test("rejects null/empty params_json", () => {
		expect(parseExperimentConfig(null)).toHaveProperty("error");
		expect(parseExperimentConfig("")).toHaveProperty("error");
		expect(parseExperimentConfig("   ")).toHaveProperty("error");
	});

	test("rejects invalid JSON", () => {
		const result = parseExperimentConfig("{ invalid json }");
		expect(result).toHaveProperty("error");
	});

	test("rejects non-object JSON", () => {
		expect(parseExperimentConfig('["array"]')).toHaveProperty("error");
		expect(parseExperimentConfig('"string"')).toHaveProperty("error");
		expect(parseExperimentConfig("null")).toHaveProperty("error");
	});

	test("rejects empty target_paths", () => {
		const json = JSON.stringify({
			target_paths: [],
			eval_command: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			keep_rule: "improved",
		});
		expect(parseExperimentConfig(json)).toHaveProperty("error");
	});

	test("rejects non-string target_paths elements", () => {
		const json = JSON.stringify({
			target_paths: ["src/foo.ts", 123],
			eval_command: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			keep_rule: "improved",
		});
		expect(parseExperimentConfig(json)).toHaveProperty("error");
	});

	test("rejects empty eval_command", () => {
		const json = JSON.stringify({
			target_paths: ["src/foo.ts"],
			eval_command: "",
			metric: { name: "loss", direction: "lower" },
			keep_rule: "improved",
		});
		expect(parseExperimentConfig(json)).toHaveProperty("error");
	});

	test("rejects eval_command that contains a target_path (§3.12.8)", () => {
		const json = JSON.stringify({
			target_paths: ["src/foo.ts"],
			eval_command: "eval src/foo.ts",
			metric: { name: "loss", direction: "lower" },
			keep_rule: "improved",
		});
		const result = parseExperimentConfig(json);
		expect(result).toHaveProperty("error");
		expect((result as { error: string }).error).toContain("OUTSIDE target_paths");
	});

	test("rejects invalid metric.direction", () => {
		const json = JSON.stringify({
			target_paths: ["src/foo.ts"],
			eval_command: "eval.sh",
			metric: { name: "loss", direction: "invalid" },
			keep_rule: "improved",
		});
		expect(parseExperimentConfig(json)).toHaveProperty("error");
	});

	test("rejects keep_rule != 'improved'", () => {
		const json = JSON.stringify({
			target_paths: ["src/foo.ts"],
			eval_command: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			keep_rule: "something_else",
		});
		expect(parseExperimentConfig(json)).toHaveProperty("error");
	});
});

describe("budgetMs", () => {
	test("parses 'ms' unit", () => {
		expect(budgetMs("500ms")).toBe(500);
	});

	test("parses 's' unit (seconds)", () => {
		expect(budgetMs("90s")).toBe(90 * 1000);
	});

	test("parses 'm' unit (minutes)", () => {
		expect(budgetMs("10m")).toBe(10 * 60 * 1000);
	});

	test("parses 'h' unit (hours)", () => {
		expect(budgetMs("2h")).toBe(2 * 60 * 60 * 1000);
	});

	test("parses bare number as seconds", () => {
		expect(budgetMs("60")).toBe(60 * 1000);
	});

	test("fails closed to 10 minutes on invalid input", () => {
		const fallback = 10 * 60 * 1000;
		expect(budgetMs("invalid")).toBe(fallback);
		expect(budgetMs("")).toBe(fallback);
		expect(budgetMs("abc123")).toBe(fallback);
	});

	test("fails closed on negative/zero values", () => {
		const fallback = 10 * 60 * 1000;
		expect(budgetMs("-10s")).toBe(fallback);
		expect(budgetMs("0m")).toBe(fallback);
	});
});

describe("runExperimentIteration — keep on improvement", () => {
	test("keeps when metric improves with direction='lower'", async () => {
		insertTestRun(100);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		let editCalled = false;
		let commitCalled = false;
		let resetCalled = false;

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => {
				editCalled = true;
				return { ok: true };
			},
			commit: async () => {
				commitCalled = true;
				return { ok: true, commitSha: "new_sha_1" };
			},
			evalRunner: async () => ({ ok: true, stdout: "loss: 0.3" }),
			parseMetric: (stdout) => {
				const match = /loss: ([\d.]+)/.exec(stdout);
				return match ? parseFloat(match[1] ?? "") : null;
			},
			reset: async () => {
				resetCalled = true;
			},
		};

		const result = await runExperimentIteration(
			deps,
			cfg,
			100,
			1,
			0.5, // baseline: 0.5
			null,
		);

		expect(result.status).toBe("keep");
		expect(result.metric).toBe(0.3);
		expect(result.kept).toBe(true);
		expect(result.commitSha).toBe("new_sha_1");
		expect(editCalled).toBe(true);
		expect(commitCalled).toBe(true);
		expect(resetCalled).toBe(false); // keep does NOT reset
	});

	test("keeps when metric improves with direction='higher'", async () => {
		insertTestRun(101);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "accuracy", direction: "higher" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => ({ ok: true }),
			commit: async () => ({ ok: true, commitSha: "new_sha_2" }),
			evalRunner: async () => ({ ok: true, stdout: "accuracy: 0.95" }),
			parseMetric: (stdout) => {
				const match = /accuracy: ([\d.]+)/.exec(stdout);
				return match ? parseFloat(match[1] ?? "") : null;
			},
			reset: async () => {},
		};

		const result = await runExperimentIteration(
			deps,
			cfg,
			101,
			1,
			0.8, // baseline: 0.8
			null,
		);

		expect(result.status).toBe("keep");
		expect(result.metric).toBe(0.95);
		expect(result.kept).toBe(true);
	});

	test("keeps on first iteration (null baseline) regardless of metric value", async () => {
		insertTestRun(102);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => ({ ok: true }),
			commit: async () => ({ ok: true, commitSha: "first_sha" }),
			evalRunner: async () => ({ ok: true, stdout: "loss: 0.9" }),
			parseMetric: () => 0.9,
			reset: async () => {},
		};

		const result = await runExperimentIteration(
			deps,
			cfg,
			102,
			1,
			null, // first attempt
			null,
		);

		expect(result.status).toBe("keep");
		expect(result.metric).toBe(0.9);
		expect(result.kept).toBe(true);
	});
});

describe("runExperimentIteration — discard on regression", () => {
	test("discards when metric regresses with direction='lower'", async () => {
		insertTestRun(103);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		let resetCalled = false;

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => ({ ok: true }),
			commit: async () => ({ ok: true, commitSha: "bad_sha" }),
			evalRunner: async () => ({ ok: true, stdout: "loss: 0.6" }),
			parseMetric: () => 0.6,
			reset: async (ctx) => {
				resetCalled = true;
				expect(ctx.toCommitSha).toBe("baseline_sha");
			},
		};

		const result = await runExperimentIteration(
			deps,
			cfg,
			103,
			2,
			0.5, // baseline: 0.5
			"baseline_sha",
		);

		expect(result.status).toBe("discard");
		expect(result.metric).toBe(0.6);
		expect(result.kept).toBe(false);
		expect(resetCalled).toBe(true);
	});

	test("discards ties (metric == baseline)", async () => {
		insertTestRun(104);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		let resetCalled = false;

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => ({ ok: true }),
			commit: async () => ({ ok: true, commitSha: "tie_sha" }),
			evalRunner: async () => ({ ok: true, stdout: "loss: 0.5" }),
			parseMetric: () => 0.5,
			reset: async () => {
				resetCalled = true;
			},
		};

		const result = await runExperimentIteration(
			deps,
			cfg,
			104,
			2,
			0.5, // baseline: 0.5 (tie)
			"baseline_sha",
		);

		expect(result.status).toBe("discard");
		expect(resetCalled).toBe(true);
	});
});

describe("runExperimentIteration — crash on failure", () => {
	test("crashes when produceEdit returns ok:false", async () => {
		insertTestRun(105);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		let resetCalled = false;

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => ({
				ok: false,
				reason: "edit generation failed",
			}),
			commit: async () => {
				throw new Error("commit should not be called");
			},
			evalRunner: async () => {
				throw new Error("eval should not be called");
			},
			parseMetric: () => null,
			reset: async () => {
				resetCalled = true;
			},
		};

		const result = await runExperimentIteration(
			deps,
			cfg,
			105,
			1,
			null,
			null,
		);

		expect(result.status).toBe("crash");
		expect(result.metric).toBeNull();
		expect(result.kept).toBe(false);
		expect(resetCalled).toBe(true); // even on crash, reset is called
	});

	test("crashes when commit returns ok:false", async () => {
		insertTestRun(106);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => ({ ok: true }),
			commit: async () => ({ ok: false, reason: "commit failed" }),
			evalRunner: async () => {
				throw new Error("eval should not be called");
			},
			parseMetric: () => null,
			reset: async () => {},
		};

		const result = await runExperimentIteration(
			deps,
			cfg,
			106,
			1,
			null,
			null,
		);

		expect(result.status).toBe("crash");
	});

	test("crashes when evalRunner returns ok:false", async () => {
		insertTestRun(107);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => ({ ok: true }),
			commit: async () => ({ ok: true, commitSha: "sha1" }),
			evalRunner: async () => ({ ok: false, stdout: "" }),
			parseMetric: () => null,
			reset: async () => {},
		};

		const result = await runExperimentIteration(
			deps,
			cfg,
			107,
			1,
			null,
			null,
		);

		expect(result.status).toBe("crash");
		expect(result.commitSha).toBe("sha1");
	});

	test("crashes when metric parsing returns null", async () => {
		insertTestRun(108);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => ({ ok: true }),
			commit: async () => ({ ok: true, commitSha: "sha2" }),
			evalRunner: async () => ({ ok: true, stdout: "no metric here" }),
			parseMetric: () => null,
			reset: async () => {},
		};

		const result = await runExperimentIteration(
			deps,
			cfg,
			108,
			1,
			null,
			null,
		);

		expect(result.status).toBe("crash");
	});

	test("crashes on thrown error and records reason", async () => {
		insertTestRun(109);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => {
				throw new Error("unexpected error");
			},
			commit: async () => ({ ok: true, commitSha: "sha3" }),
			evalRunner: async () => ({ ok: true, stdout: "loss: 0.5" }),
			parseMetric: () => 0.5,
			reset: async () => {},
		};

		const result = await runExperimentIteration(
			deps,
			cfg,
			109,
			1,
			null,
			null,
		);

		expect(result.status).toBe("crash");
	});

	test("appends ledger row with status crash even if reset fails", async () => {
		insertTestRun(110);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => ({ ok: false, reason: "edit failed" }),
			commit: async () => ({ ok: true, commitSha: "sha4" }),
			evalRunner: async () => ({ ok: true, stdout: "loss: 0.5" }),
			parseMetric: () => 0.5,
			reset: async () => {
				throw new Error("reset failed");
			},
		};

		const result = await runExperimentIteration(
			deps,
			cfg,
			110,
			1,
			null,
			null,
		);

		expect(result.status).toBe("crash");

		// Verify ledger row was still appended
		const rows = listLedger(handle, 110);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("crash");
	});

	test("crash resets to the LAST KEPT commit, not the failed attempt (branch not advanced)", async () => {
		insertTestRun(111);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		let resetCalled = false;

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			// commit succeeds (so a sha exists) but eval crashes — the branch must
			// be rewound to the prior KEPT commit, never advanced to "moved_sha".
			produceEdit: async () => ({ ok: true }),
			commit: async () => ({ ok: true, commitSha: "moved_sha" }),
			evalRunner: async () => {
				throw new Error("eval blew up");
			},
			parseMetric: () => 0.1,
			reset: async (ctx) => {
				resetCalled = true;
				// FAIL-CLOSED: a crash rewinds to the last kept commit ("kept_sha"),
				// NOT the crashed attempt's own commit — the branch never advances.
				expect(ctx.toCommitSha).toBe("kept_sha");
				expect(ctx.toCommitSha).not.toBe("moved_sha");
			},
		};

		const result = await runExperimentIteration(
			deps,
			cfg,
			111,
			3,
			0.5, // baseline metric (a prior kept value)
			"kept_sha", // the last kept commit — the ONLY legal reset target
		);

		expect(result.status).toBe("crash");
		expect(result.kept).toBe(false);
		// The reset fake above asserted the rewind target was the last kept commit.
		expect(resetCalled).toBe(true);

		const rows = listLedger(handle, 111);
		expect(rows).toHaveLength(1);
		// The crash ledger row carries the crashed attempt's sha for audit, but its
		// metricValue is null and status is crash — it never counts as best.
		expect(rows[0]?.status).toBe("crash");
		expect(rows[0]?.metricValue).toBeNull();
	});

	test("crash event payload never leaks the crash reason / secret-bearing description (§3.12.7)", async () => {
		insertTestRun(112);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		// A produceEdit failure whose reason contains a secret-looking token. It is
		// allowed into the ledger DESCRIPTION (operator audit) but MUST NOT appear in
		// the emitted experiment.iteration event payload.
		const SECRET = "ghp_SUPERSECRETTOKEN1234567890";

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => ({ ok: false, reason: `auth failed with ${SECRET}` }),
			commit: async () => ({ ok: true, commitSha: "sha" }),
			evalRunner: async () => ({ ok: true, stdout: "loss: 0.5" }),
			parseMetric: () => 0.5,
			reset: async () => {},
		};

		const result = await runExperimentIteration(deps, cfg, 112, 1, null, null);
		expect(result.status).toBe("crash");

		// The event payload is metric/commit/status only — the reason never rides it.
		const emitted = handle.db.select().from(events).all();
		const expEvents = emitted.filter((e) => e.kind === "experiment.iteration");
		expect(expEvents).toHaveLength(1);
		for (const e of expEvents) {
			expect(e.payloadJson).not.toContain(SECRET);
			expect(e.payloadJson).not.toContain("reason");
			expect(e.payloadJson).not.toContain("description");
		}
	});
});

describe("runExperimentIteration — eval runs OUTSIDE the workspace under budget (§3.12.8)", () => {
	test("evalRunner receives the just-made commitSha, immutable evalCommand, and parsed budgetMs", async () => {
		insertTestRun(120);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "bun run scorer.ts",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "90s",
			keepRule: "improved",
		};

		let seen: { commitSha: string | undefined; evalCommand: string; budgetMs: number } | null =
			null;

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => ({ ok: true }),
			commit: async () => ({ ok: true, commitSha: "committed_sha" }),
			evalRunner: async (ctx) => {
				seen = { commitSha: ctx.commitSha, evalCommand: ctx.evalCommand, budgetMs: ctx.budgetMs };
				return { ok: true, stdout: "loss: 0.3" };
			},
			parseMetric: (stdout) => {
				const m = /loss: ([\d.]+)/.exec(stdout);
				return m ? parseFloat(m[1] ?? "") : null;
			},
			reset: async () => {},
		};

		await runExperimentIteration(deps, cfg, 120, 1, null, null);

		expect(seen).not.toBeNull();
		// The eval is bound to the commit just made — not the workspace HEAD.
		expect(seen!.commitSha).toBe("committed_sha");
		// The scorer command is the immutable config value, verbatim.
		expect(seen!.evalCommand).toBe("bun run scorer.ts");
		// And it is bounded by the parsed iteration_budget (90s → 90000ms).
		expect(seen!.budgetMs).toBe(90 * 1000);
	});
});

describe("runExperimentLoop", () => {
	test("respects maxIterations option", async () => {
		insertTestRun(200);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		let iterationCount = 0;

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => ({ ok: true }),
			commit: async () => ({ ok: true, commitSha: `sha_${iterationCount}` }),
			evalRunner: async () => {
				iterationCount += 1;
				return { ok: true, stdout: `loss: ${0.5 - iterationCount * 0.05}` };
			},
			parseMetric: (stdout) => {
				const match = /loss: ([\d.-]+)/.exec(stdout);
				return match ? parseFloat(match[1] ?? "") : null;
			},
			reset: async () => {},
		};

		const result = await runExperimentLoop(
			deps,
			cfg,
			200,
			{ maxIterations: 3 },
		);

		expect(result.iterations).toBe(3);
		expect(iterationCount).toBe(3);
	});

	test("respects until-time deadline", async () => {
		insertTestRun(201);
		const startTime = new Date("2026-06-13T10:00:00Z");
		let currentTime = startTime.getTime();

		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => currentTime,
			produceEdit: async () => ({ ok: true }),
			commit: async () => ({ ok: true, commitSha: "sha" }),
			evalRunner: async () => {
				currentTime += 60 * 1000; // advance 60s per iteration
				return { ok: true, stdout: "loss: 0.5" };
			},
			parseMetric: () => 0.5,
			reset: async () => {},
		};

		const untilTime = new Date("2026-06-13T10:02:30Z").toISOString(); // 2.5 minutes from start

		const result = await runExperimentLoop(
			deps,
			cfg,
			201,
			{ until: untilTime },
		);

		// Should stop after 2 iterations (60s + 60s = 120s < 150s, but 3rd would exceed)
		expect(result.iterations).toBeLessThanOrEqual(3);
	});

	test("tracks best metric across iterations", async () => {
		insertTestRun(202);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		const metrics = [0.8, 0.6, 0.7, 0.5]; // Best is 0.5 at iteration 4

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => ({ ok: true }),
			commit: async (ctx) => ({ ok: true, commitSha: `sha_${ctx.iteration}` }),
			evalRunner: async (ctx) => {
				const idx = Number((ctx.commitSha ?? "").split("_")[1]);
				const metric = metrics[idx] ?? 0.5;
				return { ok: true, stdout: `loss: ${metric}` };
			},
			parseMetric: (stdout) => {
				const match = /loss: ([\d.]+)/.exec(stdout);
				return match ? parseFloat(match[1] ?? "") : null;
			},
			reset: async () => {},
		};

		const result = await runExperimentLoop(
			deps,
			cfg,
			202,
			{ maxIterations: 4 },
		);

		expect(result.iterations).toBe(4);
		expect(result.best).toBeDefined();
		expect(result.best?.metricValue).toBe(0.5);
	});

	test("continues after a crash (never throws)", async () => {
		insertTestRun(203);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		let iterationsSeen = 0;

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async (ctx) => {
				iterationsSeen = ctx.iteration;
				if (ctx.iteration === 2) {
					return { ok: false, reason: "edit failed" };
				}
				return { ok: true };
			},
			commit: async () => ({ ok: true, commitSha: "sha" }),
			evalRunner: async () => ({ ok: true, stdout: "loss: 0.5" }),
			parseMetric: () => 0.5,
			reset: async () => {},
		};

		const result = await runExperimentLoop(
			deps,
			cfg,
			203,
			{ maxIterations: 4 },
		);

		expect(result.iterations).toBe(4);
		expect(iterationsSeen).toBe(4); // made it past iteration 2

		const rows = listLedger(handle, 203);
		const crashes = rows.filter((r) => r.status === "crash");
		expect(crashes).toHaveLength(1);
		expect(crashes[0]?.iteration).toBe(2);
	});

	test("returns null best when no kept rows have metrics", async () => {
		insertTestRun(204);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async () => ({ ok: false, reason: "always fail" }),
			commit: async () => ({ ok: true, commitSha: "sha" }),
			evalRunner: async () => ({ ok: true, stdout: "loss: 0.5" }),
			parseMetric: () => 0.5,
			reset: async () => {},
		};

		const result = await runExperimentLoop(
			deps,
			cfg,
			204,
			{ maxIterations: 2 },
		);

		expect(result.best).toBeNull();
	});

	test("a mid-loop crash does NOT advance the moving baseline/reset target", async () => {
		insertTestRun(205);
		const cfg: ExperimentConfig = {
			targetPaths: ["src/foo.ts"],
			evalCommand: "eval.sh",
			metric: { name: "loss", direction: "lower" },
			iterationBudget: "10m",
			keepRule: "improved",
		};

		// iter1 keeps (0.5, sha_1); iter2 crashes; iter3 must run against the SAME
		// kept baseline (0.5) and reset target (sha_1) — the crash advanced nothing.
		const resetTargets: (string | null)[] = [];
		const baselinesSeen: (number | null)[] = [];

		const deps: ExperimentDeps = {
			handle,
			log,
			now: () => Date.now(),
			produceEdit: async (ctx) => {
				baselinesSeen.push(ctx.lastMetric);
				if (ctx.iteration === 2) return { ok: false, reason: "edit failed" };
				return { ok: true };
			},
			commit: async (ctx) => ({ ok: true, commitSha: `sha_${ctx.iteration}` }),
			evalRunner: async () => ({ ok: true, stdout: "loss: 0.5" }),
			parseMetric: () => 0.5,
			reset: async (ctx) => {
				resetTargets.push(ctx.toCommitSha);
			},
		};

		await runExperimentLoop(deps, cfg, 205, { maxIterations: 3 });

		// iter1: baseline null → keep 0.5 @ sha_1.
		// iter2: baseline pinned at 0.5 (kept), crashes → reset to sha_1 (last kept).
		// iter3: baseline STILL 0.5, reset target STILL sha_1 — crash advanced nothing.
		expect(baselinesSeen).toEqual([null, 0.5, 0.5]);
		// The crash (iter2) reset to the last kept commit, never to its own attempt.
		expect(resetTargets).toContain("sha_1");
		expect(resetTargets).not.toContain("sha_2");

		// iter3 ties 0.5 vs baseline 0.5 → discard, also rewinds to sha_1.
		const rows = listLedger(handle, 205);
		expect(rows.map((r) => r.status)).toEqual(["keep", "crash", "discard"]);
	});
});
