/**
 * WHY: L6 root-invoked entrypoint for egress ACTIVATION. ops/egress-apply.sh
 * shells into this under sudo (nft needs root). It is a thin argv→config
 * adapter over applyEgressRuleset — no logic of its own beyond parsing
 * `--uid <uid> [--host <h>]…`. Hosts default to the provider+GitHub allowlist so
 * the common case (Anthropic + OpenAI + GitHub) needs no flags.
 *
 * FAIL-CLOSED: applyEgressRuleset throws on non-Linux / nft failure; this CLI
 * lets that propagate and exits non-zero. It never falls back to running
 * unfiltered. Runtime is LINUX-VERIFY-ONLY (owner runs it on the Linux host).
 */

import { applyEgressRuleset } from "./apply.ts";
import { defaultAllowedHosts, type EgressConfig } from "./allowlist.ts";

/** Pure: parse `--uid <n> [--host <h>]…` into an EgressConfig. */
export function parseApplyArgs(argv: string[]): EgressConfig {
	let uid: number | undefined;
	const hosts: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--uid") {
			const raw = argv[++i];
			const parsed = Number(raw);
			if (raw === undefined || !Number.isInteger(parsed) || parsed < 0) {
				throw new Error(`--uid requires a non-negative integer, got "${raw}"`);
			}
			uid = parsed;
		} else if (arg === "--host") {
			const h = argv[++i];
			if (h === undefined || h.length === 0) {
				throw new Error("--host requires a hostname");
			}
			hosts.push(h);
		} else {
			throw new Error(`unknown argument "${arg}"`);
		}
	}
	if (uid === undefined) {
		throw new Error("--uid <uid> is required");
	}
	const allowedHosts =
		hosts.length > 0
			? defaultAllowedHosts(hosts)
			: defaultAllowedHosts(["api.anthropic.com", "api.openai.com"]);
	return { uid, allowedHosts };
}

// Only run when invoked directly (not when imported by the test).
if (import.meta.main) {
	const cfg = parseApplyArgs(Bun.argv.slice(2));
	await applyEgressRuleset({}, cfg);
	console.log(
		`egress active for uid ${cfg.uid}; allowed: ${cfg.allowedHosts.join(", ")}`,
	);
}
