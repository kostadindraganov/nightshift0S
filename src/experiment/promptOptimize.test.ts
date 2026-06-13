import { describe, expect, test } from "bun:test";
import { optimizePrompt, type OptimizeDeps } from "./promptOptimize.ts";

// A strictly-improving proposal is adopted; round 0 records the baseline; and
// `best` equals the highest-scored adopted candidate across the run.
test("strictly-improving proposal is adopted; round 0 is the baseline; best is the champion", async () => {
	const scores: Record<string, number> = { seed: 1, "seed+1": 2, "seed+1+2": 3 };
	const deps: OptimizeDeps = {
		propose: async (current, round) => `${current}+${round}`,
		evaluate: async (prompt) => scores[prompt] ?? 0,
		maxRounds: 2,
	};

	const { best, ledger } = await optimizePrompt(deps, "seed");

	expect(ledger[0]).toEqual({ round: 0, prompt: "seed", score: 1, kept: true });
	expect(ledger.filter((s) => s.kept && s.round > 0).map((s) => s.score)).toEqual([2, 3]);
	expect(best).toEqual({ prompt: "seed+1+2", score: 3 });
});

// A worse (and a tied) proposal is discarded — the champion is unchanged.
test("a worse or tied proposal is discarded; champion unchanged", async () => {
	const deps: OptimizeDeps = {
		propose: async (_current, round) => `cand${round}`,
		// round 1 worse (3 < 5), round 2 a tie (5 == 5) — both discard.
		evaluate: async (prompt) => (prompt === "seed" ? 5 : prompt === "cand1" ? 3 : 5),
		maxRounds: 2,
	};

	const { best, ledger } = await optimizePrompt(deps, "seed");

	expect(best).toEqual({ prompt: "seed", score: 5 });
	expect(ledger.filter((s) => s.round > 0).every((s) => !s.kept)).toBe(true);
});

// A throwing evaluate is recorded as a discarded step and does NOT advance the
// champion — and optimizePrompt does NOT reject (NEVER-STOP within bounds).
test("throwing evaluate is a discarded step, does not advance champion, does not reject", async () => {
	const deps: OptimizeDeps = {
		propose: async (_current, round) => `cand${round}`,
		evaluate: async (prompt) => {
			if (prompt === "cand1") throw new Error("eval boom");
			return prompt === "seed" ? 1 : 9; // cand2 would win if reached
		},
		maxRounds: 2,
	};

	const { best, ledger } = await optimizePrompt(deps, "seed");

	const crashed = ledger.find((s) => s.round === 1);
	expect(crashed).toMatchObject({ round: 1, score: -Infinity, kept: false });
	expect(crashed?.error).toContain("eval boom");
	// Champion still progresses on the later good round → crash never blocked it.
	expect(best).toEqual({ prompt: "cand2", score: 9 });
});

// The loop runs EXACTLY maxRounds proposal rounds (plus the round-0 baseline).
test("loop runs exactly maxRounds proposal rounds", async () => {
	let proposeCalls = 0;
	const deps: OptimizeDeps = {
		propose: async (current, round) => {
			proposeCalls++;
			return `${current}.${round}`;
		},
		evaluate: async () => 0, // never improves over baseline 0 (ties discard)
		maxRounds: 4,
	};

	const { ledger } = await optimizePrompt(deps, "seed");

	expect(proposeCalls).toBe(4);
	expect(ledger).toHaveLength(5); // round 0 + 4 proposal rounds
	expect(ledger.filter((s) => s.round > 0)).toHaveLength(4);
});

// A failed seed eval fails closed to -Infinity (recorded with the error) while
// the champion prompt stays the seed; a later numeric round then overtakes it.
test("failed seed eval fails closed to -Infinity baseline and is overtaken", async () => {
	const deps: OptimizeDeps = {
		propose: async (_current, round) => `cand${round}`,
		evaluate: async (prompt) => {
			if (prompt === "seed") throw new Error("seed boom");
			return 7;
		},
		maxRounds: 1,
	};

	const { best, ledger } = await optimizePrompt(deps, "seed");

	expect(ledger[0]).toMatchObject({ round: 0, prompt: "seed", score: -Infinity, kept: false });
	expect(ledger[0]?.error).toContain("seed boom");
	expect(best).toEqual({ prompt: "cand1", score: 7 });
});
