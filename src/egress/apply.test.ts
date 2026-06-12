/**
 * WHY: hermetic coverage of L6 egress ACTIVATION — pure argv/ruleset gen and
 * the fail-closed sequencing only. NO nft is ever executed and NO network
 * resolution happens: the runner and resolver are injected fakes, so every
 * assertion is on the BUILT nft argv, never on a real kernel change. Live
 * enforcement is LINUX-VERIFY-ONLY (owner runs nft on the Linux host).
 */

import { describe, expect, test } from "bun:test";
import {
	applyEgressRuleset,
	buildAddElementCmds,
	EgressApplyError,
	type ApplyDeps,
} from "./apply.ts";
import type { EgressConfig } from "./allowlist.ts";

describe("L6 egress apply (hermetic — no nft, no network)", () => {
	test("buildAddElementCmds: argv shape per host; zero-IP host SKIPPED (stays DROPPED)", () => {
		const cmds = buildAddElementCmds(1234, [
			["1.1.1.1", "1.0.0.1"], // host 0 → set allowed_ips_0
			[], // host 1 → no IPs → skipped (fail-closed: stays dropped)
			["8.8.8.8"], // host 2 → set allowed_ips_2
		]);
		expect(cmds).toEqual([
			[
				"nft", "add", "element", "inet", "nightshift_egress_uid1234",
				"allowed_ips_0", "{ 1.1.1.1, 1.0.0.1 }",
			],
			[
				"nft", "add", "element", "inet", "nightshift_egress_uid1234",
				"allowed_ips_2", "{ 8.8.8.8 }",
			],
		]);
	});

	test("applyEgressRuleset: FAIL-CLOSED on non-Linux — throws, runner never called", async () => {
		let runCalls = 0;
		const deps: ApplyDeps = {
			platform: "darwin",
			run: async (argv) => {
				runCalls++;
				return argv.join(" ");
			},
			resolve: async () => ["1.1.1.1"],
		};
		const cfg: EgressConfig = { uid: 1000, allowedHosts: ["api.anthropic.com"] };
		await expect(applyEgressRuleset(deps, cfg)).rejects.toBeInstanceOf(
			EgressApplyError,
		);
		expect(runCalls).toBe(0); // no nft side effect attempted
	});

	test("applyEgressRuleset: on fake-Linux the nft argv sequence is asserted (load → add-element → verify)", async () => {
		const argvLog: string[][] = [];
		const deps: ApplyDeps = {
			platform: "linux",
			run: async (argv) => {
				argvLog.push(argv);
				return "";
			},
			// host 0 resolves; host 1 fails → empty set → that add-element is skipped.
			resolve: async (host) => {
				if (host === "github.com") {
					throw new Error("resolution failure");
				}
				return ["203.0.113.7"];
			},
		};
		const cfg: EgressConfig = {
			uid: 4242,
			allowedHosts: ["api.anthropic.com", "github.com"],
		};
		await applyEgressRuleset(deps, cfg);

		expect(argvLog[0]?.slice(0, 2)).toEqual(["nft", "-f"]); // 1) load ruleset file
		expect(argvLog[1]).toEqual([
			// 2) populate ONLY the resolvable host's set
			"nft", "add", "element", "inet", "nightshift_egress_uid4242",
			"allowed_ips_0", "{ 203.0.113.7 }",
		]);
		expect(argvLog[2]).toEqual([
			// 3) verify the table is live → egressActive() will now find it
			"nft", "list", "table", "inet", "nightshift_egress_uid4242",
		]);
		expect(argvLog).toHaveLength(3); // github.com (empty) produced no add-element
	});
});
