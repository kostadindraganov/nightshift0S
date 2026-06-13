/**
 * WHY: Live third-reviewer producer for the V3 three-model tiebreaker (Phase 7
 * §7.7). `tiebreaker.ts` owns the pure decision logic and exposes a
 * `TiebreakDeps.runTiebreaker` seam; this module builds the LIVE closure that
 * satisfies that seam by spawning a one-shot reviewer via
 * `spawnOneShotCaptured` (same pattern as `makeRunReviewer` in liveSpawn.ts).
 *
 * Decision contract (from tiebreaker.ts):
 *   - Called ONLY on genuine disagreement (primary≠challenger binary verdict).
 *   - Returns the third model's Verdict; that becomes the deciding vote.
 *   - FAIL-CLOSED: any error here defers to `stricter` (block wins), enforced
 *     by `resolveWithTiebreak` in tiebreaker.ts when `runTiebreaker` throws.
 *     We also throw on missing/unknown provider — never fabricate a verdict.
 *
 * Injectable: `TiebreakerDeps.spawner` defaults to `spawnOneShotCaptured` so
 * the module is fully testable with fake spawners and no real process or LLM.
 * No side effects at import time or module scope.
 *
 * Prompt: `codeReviewJudge.buildPrompt` with empty `priorFindings` (round 1
 * context — the tiebreaker always sees the original diff, not a delta). The
 * judge's sanitization is the sanitization chokepoint; `tiebreaker.ts` also
 * runs `sanitizeUntrusted` on the TiebreakInput fields before we receive them.
 *
 * Parse: `codeReviewJudge.parse(stdout)` — same structured envelope the
 * primary/challenger use. Parse failure → throw (fail-closed; tiebreaker.ts
 * defers to stricter on throws from runTiebreaker).
 */

import type { TiebreakInput, TiebreakDeps } from "../review/tiebreaker.ts";
import type { Verdict } from "../review/verdict.ts";
import { codeReviewJudge } from "../review/judge.ts";
import {
	buildOneShotArgv,
	spawnOneShotCaptured,
	type OneShotSpawner,
} from "../runs/liveSpawn.ts";

// ---------------------------------------------------------------------------
// Injectable deps
// ---------------------------------------------------------------------------

export interface TiebreakerDeps {
	/**
	 * Provider string recognised by `buildOneShotArgv`, e.g. "claude-code" or
	 * "codex". Empty string / unknown value → `buildOneShotArgv` throws
	 * OneShotDisabledError (fail-closed).
	 */
	tiebreakerProvider: string;

	/** Root dir under which per-task HOME dirs live. Default ~/.nightshift/homes. */
	homeRoot?: string;

	/**
	 * Working directory for the one-shot spawn. Should be the reviewer's cwd
	 * (task worktree). Default process.cwd().
	 */
	cwd?: string;

	/**
	 * Per-task HOME path used by the one-shot subprocess. Default is derived
	 * from homeRoot when not supplied; callers may override for tests.
	 */
	home?: string;

	/** Injectable spawner — default `spawnOneShotCaptured`. */
	spawner?: OneShotSpawner;
}

// ---------------------------------------------------------------------------
// Internal helpers (pure)
// ---------------------------------------------------------------------------

function defaultHomeRoot(): string {
	return `${process.env.HOME ?? "/tmp"}/.nightshift/homes`;
}

/** ro-bound provider credential dir under the per-task HOME. */
function providerAuthDir(home: string, provider: string): string {
	return provider === "codex" ? `${home}/.codex` : `${home}/.claude`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the `TiebreakDeps["runTiebreaker"]` closure that `resolveWithTiebreak`
 * in `tiebreaker.ts` calls when the two primary reviewers disagree.
 *
 * The returned closure:
 *   1. Builds a judge prompt via `codeReviewJudge.buildPrompt` (no prior
 *      findings — the tiebreaker always reviews the current state fresh).
 *   2. Spawns a one-shot via `deps.spawner` (default `spawnOneShotCaptured`).
 *   3. Parses stdout with `codeReviewJudge.parse`.
 *   4. Returns the parsed `Verdict` — or throws on any failure so that
 *      `resolveWithTiebreak` falls to `stricter` (block wins, fail-closed).
 *
 * The factory is inert: no I/O occurs until the returned closure is called.
 */
export function makeTiebreakerReviewer(
	deps: TiebreakerDeps,
): (input: TiebreakInput) => Promise<Verdict> {
	const spawner = deps.spawner ?? spawnOneShotCaptured;
	const homeRoot = deps.homeRoot ?? defaultHomeRoot();

	// Validate provider eagerly so wiring errors surface at startup, not at
	// first tie. `buildOneShotArgv` throws OneShotDisabledError on unknown.
	const argv = buildOneShotArgv(deps.tiebreakerProvider);

	return async (input: TiebreakInput): Promise<Verdict> => {
		const home = deps.home ?? `${homeRoot}/tiebreaker`;
		const cwd = deps.cwd ?? process.cwd();

		// Build a round-1 judge prompt from the TiebreakInput fields.
		// `codeReviewJudge.buildPrompt` internally sanitizes all untrusted fields;
		// tiebreaker.ts also ran `sanitizeUntrusted` on them before calling us.
		const prompt = codeReviewJudge.buildPrompt({
			prTitle: input.prTitle,
			prBody: input.prBody,
			diff: input.diff,
			round: input.round,
			priorFindings: [],
		});

		const result = await spawner({
			argv,
			prompt,
			cwd,
			home,
			providerAuthDir: providerAuthDir(home, deps.tiebreakerProvider),
		});

		const parsed = codeReviewJudge.parse(result.stdout);
		if (!parsed.ok) {
			// Throw so resolveWithTiebreak defers to stricter (fail-closed).
			throw new Error(
				`[tiebreakerReviewer] tiebreaker parse failed (provider=${deps.tiebreakerProvider}): ${parsed.reason}`,
			);
		}

		return parsed.verdict;
	};
}
