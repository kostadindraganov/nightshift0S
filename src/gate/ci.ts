/**
 * CI gate (task 2.7).
 *
 * Determines whether the required CI checks are green before a PR/merge is
 * allowed to proceed.
 *
 * Pass/fail rules:
 *   - A required check with status "success", "neutral", or "skipped" → OK.
 *   - A required check with status "failure", "error", or "pending" → blocking.
 *   - A required check that is entirely absent from the check list → blocking
 *     (reported as "name(missing)").
 *
 * ciGate() is a pure function — no I/O. ciGateForRef() composes a CiClient
 * fetch with ciGate(). The live GitHub Checks API implementation is
 * DEPLOY-PENDING; inject a fake CiClient in tests.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus =
  | "success"
  | "failure"
  | "pending"
  | "error"
  | "neutral"
  | "skipped";

export interface CheckRun {
  name: string;
  status: CheckStatus;
}

export interface CiGateResult {
  /** True when no required check is blocking. */
  green: boolean;
  /**
   * Names of blocking checks with a reason suffix, e.g. "lint(failure)",
   * "typecheck(pending)", "build(missing)".
   */
  blocking: string[];
}

/** Injectable client for fetching CI check runs from a remote system. */
export interface CiClient {
  fetchChecks(ref: string): Promise<CheckRun[]>;
}

// ---------------------------------------------------------------------------
// Pure gate logic
// ---------------------------------------------------------------------------

/** Statuses that do NOT block a merge. */
const NON_BLOCKING_STATUSES = new Set<CheckStatus>([
  "success",
  "neutral",
  "skipped",
]);

/**
 * Pure function. Given required check names and the observed check runs,
 * returns whether the gate is green and the list of blocking check names.
 */
export function ciGate({
  requiredChecks,
  checks,
}: {
  requiredChecks: string[];
  checks: CheckRun[];
}): CiGateResult {
  const byName = new Map<string, CheckStatus>(
    checks.map((c) => [c.name, c.status]),
  );

  const blocking: string[] = [];

  for (const name of requiredChecks) {
    const status = byName.get(name);
    if (status === undefined) {
      blocking.push(`${name}(missing)`);
    } else if (!NON_BLOCKING_STATUSES.has(status)) {
      blocking.push(`${name}(${status})`);
    }
  }

  return { green: blocking.length === 0, blocking };
}

// ---------------------------------------------------------------------------
// Async composition
// ---------------------------------------------------------------------------

/**
 * Fetches check runs for `ref` via the injected CiClient, then evaluates
 * ciGate for the given required check names.
 *
 * The live implementation of CiClient (GitHub Checks / Statuses API) is
 * DEPLOY-PENDING; use a fake client in unit tests.
 */
export async function ciGateForRef(
  client: CiClient,
  ref: string,
  requiredChecks: string[],
): Promise<CiGateResult> {
  const checks = await client.fetchChecks(ref);
  return ciGate({ requiredChecks, checks });
}
