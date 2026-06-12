/**
 * WHY: L6 egress ACTIVATION (BLUEPRINT §3.12.23, THREAT-MODEL B2). allowlist.ts
 * only GENERATES the nft ruleset string; this module is the side-effecting layer
 * that actually loads it into the Linux kernel via nft(8) and tears it down. It
 * is what makes guard.ts's egressActive() flip true: applyEgressRuleset writes
 * the ruleset built by buildNftablesRuleset (whose table name already matches
 * guard.ts's NFT_TABLE_PREFIX), so once applied the unattended-untrusted gate
 * opens.
 *
 * FAIL-CLOSED CONTRACT: nftables is Linux-only. On any non-Linux platform —
 * or any nft failure — these functions THROW EgressApplyError. There is NO
 * "warn and continue unfiltered" path: a missing nft binary or a non-Linux host
 * must refuse, never silently no-op. A host with zero resolved IPs is the one
 * NON-error fail-closed case: its named set stays empty, so that host stays
 * DROPPED by the default-DROP rule (an empty allowlist is the safe direction).
 *
 * All side effects are injectable (ApplyDeps.resolve / ApplyDeps.run /
 * ApplyDeps.platform) so the pure argv builders and the apply/teardown
 * sequencing are unit-testable on macOS with fakes — no real nft, no network,
 * no root. Live enforcement is LINUX-VERIFY-ONLY at runtime (owner tests on the
 * Linux host); macOS verification is typecheck + hermetic argv assertions only.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve4 } from "node:dns/promises";
import { buildNftablesRuleset, type EgressConfig } from "./allowlist.ts";

const execFileAsync = promisify(execFile);

/** Table name nightshift loads; MUST match guard.ts NFT_TABLE_PREFIX + uid. */
function tableName(uid: number): string {
	return `nightshift_egress_uid${uid}`;
}

/** Thrown whenever egress activation/teardown cannot proceed (fail-closed). */
export class EgressApplyError extends Error {
	override readonly name = "EgressApplyError";

	constructor(message: string) {
		super(message);
	}
}

export interface ApplyDeps {
	/** Injectable host→IPv4 resolver; default node:dns/promises resolve4. */
	resolve?: (host: string) => Promise<string[]>;
	/** Injectable command runner; default execFile. Tests inject a fake. */
	run?: (argv: string[]) => Promise<string>;
	/** Default process.platform — overridable so tests can simulate "linux". */
	platform?: NodeJS.Platform;
}

/** Default command runner: execFile(argv[0], argv[1:]); returns stdout. */
async function defaultRun(argv: string[]): Promise<string> {
	const [cmd, ...args] = argv;
	if (cmd === undefined) {
		throw new EgressApplyError("empty argv passed to run");
	}
	const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000 });
	return stdout;
}

/**
 * Pure: build the per-host `nft add element` argv lists from already-resolved
 * IPs. The i-th entry of `ipsByHostIndex` corresponds to allowed host i and its
 * named set `allowed_ips_${i}` (the same index scheme buildNftablesRuleset
 * emits).
 *
 * Hosts with ZERO resolved IPs are SKIPPED (no argv emitted) — their set stays
 * empty, so that host stays DROPPED by the default-DROP rule. This is the
 * fail-closed direction: a resolution failure narrows access, never widens it,
 * and never errors.
 *
 * Each emitted argv:
 *   ["nft","add","element","inet",`nightshift_egress_uid${uid}`,
 *    `allowed_ips_${i}`,`{ ${ips.join(", ")} }`]
 */
export function buildAddElementCmds(
	uid: number,
	ipsByHostIndex: string[][],
): string[][] {
	const table = tableName(uid);
	const cmds: string[][] = [];
	for (let i = 0; i < ipsByHostIndex.length; i++) {
		const ips = ipsByHostIndex[i] ?? [];
		if (ips.length === 0) {
			continue; // empty set ⇒ host stays DROPPED (fail-closed, not an error)
		}
		cmds.push([
			"nft",
			"add",
			"element",
			"inet",
			table,
			`allowed_ips_${i}`,
			`{ ${ips.join(", ")} }`,
		]);
	}
	return cmds;
}

/** Pure: argv that loads a ruleset file into the kernel. */
export function buildLoadFileCmd(file: string): string[] {
	return ["nft", "-f", file];
}

/** Pure: argv that verifies the nightshift table exists for `uid`. */
export function buildListTableCmd(uid: number): string[] {
	return ["nft", "list", "table", "inet", tableName(uid)];
}

/** Pure: argv that destroys the nightshift table for `uid` (idempotent teardown). */
export function buildDeleteTableCmd(uid: number): string[] {
	return ["nft", "delete", "table", "inet", tableName(uid)];
}

/**
 * Activate the egress allowlist for `cfg.uid` on Linux.
 *
 * Sequence:
 *   1. platform !== "linux" ⇒ throw EgressApplyError (fail-closed; never no-op).
 *   2. buildNftablesRuleset(cfg) → write to a 0600 temp file → run ["nft","-f",file].
 *   3. resolve every cfg.allowedHosts (in index order) → run each
 *      buildAddElementCmds argv (empty-IP hosts are skipped → stay DROPPED).
 *   4. verify: run ["nft","list","table","inet",`nightshift_egress_uid${uid}`].
 *
 * Throws EgressApplyError on any nft failure — never swallows it. The temp file
 * is always removed (even on failure). LINUX-VERIFY-ONLY at runtime.
 */
export async function applyEgressRuleset(
	deps: ApplyDeps,
	cfg: EgressConfig,
): Promise<void> {
	const platform = deps.platform ?? process.platform;
	if (platform !== "linux") {
		throw new EgressApplyError(
			`egress activation requires Linux nftables; refusing on platform "${platform}" (fail-closed)`,
		);
	}

	const run = deps.run ?? defaultRun;
	const resolve = deps.resolve ?? resolve4;

	// Step 2: write the generated ruleset to a 0600 temp file and load it.
	const ruleset = buildNftablesRuleset(cfg);
	const file = `/tmp/nightshift-egress-uid${cfg.uid}-${process.pid}.nft`;
	try {
		await Bun.write(file, ruleset, { mode: 0o600 });
		await run(buildLoadFileCmd(file));

		// Step 3: resolve hosts in index order, then populate each named set.
		const ipsByHostIndex: string[][] = [];
		for (const host of cfg.allowedHosts) {
			try {
				ipsByHostIndex.push(await resolve(host));
			} catch {
				// Resolution failure ⇒ empty set ⇒ host stays DROPPED (fail-closed).
				ipsByHostIndex.push([]);
			}
		}
		for (const argv of buildAddElementCmds(cfg.uid, ipsByHostIndex)) {
			await run(argv);
		}

		// Step 4: verify the table is live (so egressActive() will now find it).
		await run(buildListTableCmd(cfg.uid));
	} catch (err) {
		if (err instanceof EgressApplyError) {
			throw err;
		}
		throw new EgressApplyError(
			`failed to apply egress ruleset for uid ${cfg.uid}: ${String(err)}`,
		);
	} finally {
		// Best-effort cleanup of the temp ruleset; never masks the real error.
		try {
			await Bun.file(file).delete();
		} catch {
			// ignore — temp file removal is non-critical
		}
	}
}

/**
 * Tear down the egress allowlist for `uid` by deleting its nft table.
 *
 * Fail-closed on platform (non-Linux ⇒ throw). After a successful teardown
 * guard.ts's egressActive() returns false again, which re-closes the
 * unattended-untrusted gate. LINUX-VERIFY-ONLY at runtime.
 */
export async function teardownRuleset(
	deps: ApplyDeps,
	uid: number,
): Promise<void> {
	const platform = deps.platform ?? process.platform;
	if (platform !== "linux") {
		throw new EgressApplyError(
			`egress teardown requires Linux nftables; refusing on platform "${platform}" (fail-closed)`,
		);
	}

	const run = deps.run ?? defaultRun;
	try {
		await run(buildDeleteTableCmd(uid));
	} catch (err) {
		throw new EgressApplyError(
			`failed to tear down egress table for uid ${uid}: ${String(err)}`,
		);
	}
}
