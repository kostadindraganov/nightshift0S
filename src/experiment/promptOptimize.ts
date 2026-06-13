/**
 * WHY: V3 prompt self-optimization — the §3.11 hill-climbing loop (engine.ts)
 * applied to a PROMPT instead of code. Each round PROPOSES a mutation of the
 * current champion prompt, EVALUATES it to a score, and keeps the candidate
 * ONLY when it scores STRICTLY better; otherwise it is discarded. Every step
 * (kept or discarded, baseline included) is recorded to an in-memory ledger.
 *
 * Same crash-safety discipline as the code experiment engine:
 *   - A thrown propose / evaluate in any round is CAUGHT, recorded as a
 *     DISCARDED step (kept:false, score:-Infinity, error:String(err)), and the
 *     loop CONTINUES — a crash NEVER advances the champion (NEVER-STOP within
 *     the maxRounds bound).
 *   - Ties do NOT improve → discard (strictly-better only), matching engine.ts.
 *   - If the seed eval throws, the baseline score fails closed to -Infinity
 *     (recorded with the error) and the champion prompt stays the seed, so any
 *     later numeric round will overtake it.
 *
 * Pure + deterministic: the only side effects (propose, evaluate) are injected
 * via OptimizeDeps. No Date.now()/Math.random() — runs on macOS with fakes.
 *
 * Ledger choice: ledger.ts's row type is SQLite-shaped (FK routine_run_id,
 * commit sha, createdAt) and keyed on a numeric metric for code iterations; it
 * does not carry the prompt text this loop hill-climbs over. So this module
 * uses the local PromptOptStep contract type rather than ExperimentLedgerRow.
 */

export interface PromptCandidate {
	prompt: string;
	score: number;
}

export interface PromptOptStep {
	round: number;
	prompt: string;
	score: number;
	kept: boolean;
	error?: string;
}

export interface OptimizeDeps {
	/** Propose a mutation of the current champion prompt for `round` (1..maxRounds). */
	propose(current: string, round: number): Promise<string>;
	/** Score a prompt; higher is better. */
	evaluate(prompt: string): Promise<number>;
	maxRounds: number;
}

/**
 * Hill-climb the seed prompt for `deps.maxRounds` proposal rounds.
 *
 * Round 0 establishes the baseline champion by evaluating the seed; a throw
 * there fails closed to score -Infinity (recorded with the error) while the
 * champion prompt stays the seed. Rounds 1..maxRounds each propose → evaluate;
 * a candidate is adopted ONLY when it scores STRICTLY better than the current
 * champion. Any throw in propose/evaluate for a round is recorded as a
 * discarded step and stepped over — the champion is never advanced by a crash.
 *
 * Returns the final champion as `best` plus the full ledger (round 0 included).
 */
export async function optimizePrompt(
	deps: OptimizeDeps,
	seed: string,
): Promise<{ best: PromptCandidate; ledger: PromptOptStep[] }> {
	const ledger: PromptOptStep[] = [];

	// Round 0: baseline champion = the seed. A failed seed eval fails closed to
	// -Infinity so any later numeric round overtakes it; the prompt stays seed.
	let champion: PromptCandidate;
	try {
		const baseScore = await deps.evaluate(seed);
		champion = { prompt: seed, score: baseScore };
		ledger.push({ round: 0, prompt: seed, score: baseScore, kept: true });
	} catch (err) {
		champion = { prompt: seed, score: -Infinity };
		ledger.push({
			round: 0,
			prompt: seed,
			score: -Infinity,
			kept: false,
			error: String(err),
		});
	}

	// Rounds 1..maxRounds: propose → evaluate → keep iff strictly better.
	for (let round = 1; round <= deps.maxRounds; round++) {
		let candidate: string;
		let score: number;
		try {
			candidate = await deps.propose(champion.prompt, round);
			score = await deps.evaluate(candidate);
		} catch (err) {
			// Crash: record-only, champion unchanged, NEVER-STOP.
			ledger.push({
				round,
				prompt: champion.prompt,
				score: -Infinity,
				kept: false,
				error: String(err),
			});
			continue;
		}

		if (score > champion.score) {
			champion = { prompt: candidate, score };
			ledger.push({ round, prompt: candidate, score, kept: true });
		} else {
			ledger.push({ round, prompt: candidate, score, kept: false });
		}
	}

	return { best: champion, ledger };
}
