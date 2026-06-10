/**
 * Pre-PR gate (task 2.7).
 *
 * Composes the freshness gate (checkBranchFreshness) and the CI gate
 * (ciGateForRef) into a single pass/fail verdict used before a PR is opened.
 *
 * Behaviour:
 *   - freshness "block"  → hard-blocks the PR (pass=false).
 *   - freshness "rebase" → does NOT hard-block but is surfaced as a required
 *     action in the result; the caller is expected to perform the rebase before
 *     proceeding (pass=true unless CI is also red).
 *   - freshness "fresh"  → no action needed.
 *   - If requiredChecks AND a CiClient are both provided, CI is evaluated;
 *     any blocking checks hard-block the PR (pass=false).
 *   - If either requiredChecks or ci is absent, the CI gate is skipped and
 *     does not contribute to the pass/fail decision.
 */

import {
  checkBranchFreshness,
  type FreshnessResult,
  type GitRunner,
} from "./freshness.ts";
import { ciGateForRef, type CiClient, type CiGateResult } from "./ci.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrePrGateInput {
  repoDir: string;
  baseSha: string;
  defaultBranch: string;
  /** The branch/ref to fetch CI checks for. Optional — CI skipped if absent. */
  headRef?: string;
  /** Required check names. Optional — CI skipped if absent or empty. */
  requiredChecks?: string[];
}

export interface PrePrGateResult {
  /** True when no hard-blocking condition was found. */
  pass: boolean;
  freshness: FreshnessResult;
  /** Present only when CI was evaluated. */
  ci?: CiGateResult;
  /** Human-readable reasons for a hard-block (empty when pass=true). */
  blocked: string[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Runs the pre-PR gate: freshness check + optional CI check.
 *
 * @param deps.git  Injected git runner (defaults to execGit if omitted at call
 *                  site; we accept undefined so callers may pass `{}` and the
 *                  inner function applies its own default).
 * @param deps.ci   Optional injectable CI client.
 */
export async function prePrGate(
  deps: { git?: GitRunner; ci?: CiClient },
  input: PrePrGateInput,
): Promise<PrePrGateResult> {
  const { git, ci } = deps;
  const { repoDir, baseSha, defaultBranch, headRef, requiredChecks } = input;

  // --- 1. Freshness ---
  const freshness = await checkBranchFreshness(git, {
    repoDir,
    baseSha,
    defaultBranch,
  });

  const blocked: string[] = [];

  if (freshness.status === "block") {
    blocked.push(`freshness: ${freshness.reason}`);
  }
  // "rebase" is surfaced in the result but does NOT hard-block.

  // --- 2. CI gate (optional) ---
  let ciResult: CiGateResult | undefined;

  const shouldCheckCi =
    ci !== undefined &&
    headRef !== undefined &&
    requiredChecks !== undefined &&
    requiredChecks.length > 0;

  if (shouldCheckCi) {
    // TypeScript needs the narrowing — guaranteed non-undefined by shouldCheckCi
    ciResult = await ciGateForRef(ci!, headRef!, requiredChecks!);
    for (const name of ciResult.blocking) {
      blocked.push(`ci: ${name}`);
    }
  }

  return {
    pass: blocked.length === 0,
    freshness,
    ...(ciResult !== undefined ? { ci: ciResult } : {}),
    blocked,
  };
}
