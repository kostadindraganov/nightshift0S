/**
 * Egress guard — refuse-unattended gate (BLUEPRINT §3.12.23, THREAT-MODEL B2,
 * fail-closed requirement #2).
 *
 * The core invariant: unattended runs on untrusted repos are DISABLED by
 * default until egress control is active. This prevents a compromised or
 * malicious repo from exfiltrating secrets/data when no human is watching.
 *
 * Two exports:
 *
 *   egressActive() — best-effort detection of whether the nft table is live.
 *     On non-Linux platforms this always returns false (nftables is Linux-only).
 *     On Linux it runs `nft list table ...` and treats exit 0 as active.
 *
 *   assertEgressOrRefuse() — the gate. Fail-closed logic:
 *     if unattended AND untrusted repo AND egress NOT active → THROW.
 *     Any other combination is permitted to proceed.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Thrown when an unattended run on an untrusted repo is attempted without egress control. */
export class EgressInactiveError extends Error {
  override readonly name = "EgressInactiveError";

  constructor(message: string) {
    super(message);
  }
}

/**
 * NFT table name that nightshift creates when egress control is active.
 * The UID-specific suffix is omitted here — we check for ANY nightshift table.
 * A more precise check would require the uid; callers who know it can pass a
 * custom tableName to the underlying nft command.
 */
const NFT_TABLE_PREFIX = "nightshift_egress_uid";

/**
 * Detect whether nftables egress control is active.
 *
 * Returns false on non-Linux (nftables is absent on macOS/Windows).
 * On Linux, runs `nft list tables` and checks for a nightshift egress table.
 * Any error (nft not installed, permission denied, table absent) → false.
 *
 * This is intentionally best-effort: a false negative is safe (the gate
 * will then refuse unattended+untrusted runs). A false positive would require
 * an attacker to have already installed a spoofed nft table, which implies
 * a deeper system compromise.
 */
export async function egressActive(): Promise<boolean> {
  if (process.platform !== "linux") {
    return false;
  }

  try {
    const { stdout } = await execFileAsync("nft", ["list", "tables"], {
      timeout: 3000,
    });
    return stdout.includes(NFT_TABLE_PREFIX);
  } catch {
    // nft not installed, permission denied, or any other failure → treat as inactive.
    return false;
  }
}

export interface AssertEgressOpts {
  /** Whether a human operator is watching this run. */
  egressActive: boolean;
  /** Whether this run was triggered without an operator present (e.g. cron, webhook). */
  unattended: boolean;
  /** Whether the target repo has been explicitly trusted by an operator. */
  trustedRepo: boolean;
}

/**
 * Fail-closed gate: throws EgressInactiveError when ALL THREE conditions hold:
 *   - unattended (no human watching)
 *   - untrusted repo (not explicitly approved)
 *   - egress NOT active (no packet-level containment)
 *
 * If any one condition is false the run is permitted:
 *   - attended: a human can intervene if something goes wrong
 *   - trusted repo: operator explicitly approved this source
 *   - egress active: exfiltration is blocked at the network layer
 */
export function assertEgressOrRefuse(opts: AssertEgressOpts): void {
  if (opts.unattended && !opts.trustedRepo && !opts.egressActive) {
    throw new EgressInactiveError(
      "unattended runs on untrusted repos are disabled until egress control is active",
    );
  }
}
