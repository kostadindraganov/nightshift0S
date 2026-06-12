/**
 * Tests for autoMergePreflight (§3.12.26) — FAIL-CLOSED gate before every merge.
 * The ForgeClient is a fake scripted per REST path (no network). ≤5 cases:
 *   - all-green snapshot passes (ok:true, no blocks)
 *   - a newer live head than approvedSha blocks (a push invalidates approval)
 *   - no classic protection AND no ruleset blocks
 *   - untrusted check-run app id blocks; empty trusted allowlist blocks
 *   - admin-perm bot token blocks; a thrown client error blocks (fail-closed)
 */

import { describe, test, expect } from "bun:test";
import { autoMergePreflight, type PreflightInput } from "./preflight.ts";
import type { ForgeClient, ForgeClientRequest, ForgeClientResponse } from "./github.ts";

// ---------------------------------------------------------------------------
// Fake ForgeClient: a map of "METHOD path" → response | thrown error
// ---------------------------------------------------------------------------

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRUSTED_APP = 15368; // e.g. GitHub Actions

type Scripted = ForgeClientResponse | { throw: string };

function makeClient(routes: Record<string, Scripted>): ForgeClient {
	return {
		async request(req: ForgeClientRequest): Promise<ForgeClientResponse> {
			const key = `${req.method} ${req.path}`;
			const hit = routes[key];
			if (hit === undefined) throw new Error(`unscripted route: ${key}`);
			if ("throw" in hit) throw new Error(hit.throw);
			return hit;
		},
	};
}

/** A fully-green route set: open PR, classic protection w/ one required check,
 *  a successful check run from the trusted app, push-only repo perms. */
function greenRoutes(head = HEAD): Record<string, Scripted> {
	return {
		"GET /repos/o/r/pulls/7": {
			status: 200,
			json: { state: "open", base: { ref: "main" }, head: { sha: head } },
		},
		"GET /repos/o/r/branches/main/protection": {
			status: 200,
			json: { required_status_checks: { contexts: ["ci/test"] } },
		},
		"GET /repos/o/r/rules/branches/main": { status: 200, json: [] },
		[`GET /repos/o/r/commits/${head}/check-runs`]: {
			status: 200,
			json: { check_runs: [{ name: "ci/test", conclusion: "success", app: { id: TRUSTED_APP } }] },
		},
		"GET /repos/o/r": { status: 200, json: { permissions: { push: true, admin: false, maintain: false } } },
	};
}

const baseInput: PreflightInput = {
	owner: "o",
	repo: "r",
	prNumber: 7,
	baseBranch: "main",
	headSha: HEAD,
	approvedSha: HEAD,
	trustedCheckAppIds: [TRUSTED_APP],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("autoMergePreflight", () => {
	test("all-green passes", async () => {
		const result = await autoMergePreflight(makeClient(greenRoutes()), baseInput);
		expect(result.ok).toBe(true);
		expect(result.blocked).toHaveLength(0);
	});

	test("a newer head SHA than the approved SHA blocks", async () => {
		const newHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		// Live head moved past the approved/local SHA — checks must reflect new head.
		const result = await autoMergePreflight(makeClient(greenRoutes(newHead)), baseInput);
		expect(result.ok).toBe(false);
		expect(result.blocked.some((b) => b.includes("head moved since approval"))).toBe(true);
	});

	test("no protection AND no ruleset blocks", async () => {
		const routes = greenRoutes();
		routes["GET /repos/o/r/branches/main/protection"] = { status: 404, json: { message: "Branch not protected" } };
		routes["GET /repos/o/r/rules/branches/main"] = { status: 200, json: [] };
		const result = await autoMergePreflight(makeClient(routes), baseInput);
		expect(result.ok).toBe(false);
		expect(result.blocked.some((b) => b.includes("no branch protection or ruleset"))).toBe(true);
	});

	test("untrusted check-run app blocks; empty allowlist also blocks", async () => {
		// (i) check run from an app NOT in the trusted allowlist.
		const routes = greenRoutes();
		routes[`GET /repos/o/r/commits/${HEAD}/check-runs`] = {
			status: 200,
			json: { check_runs: [{ name: "ci/test", conclusion: "success", app: { id: 99999 } }] },
		};
		const untrusted = await autoMergePreflight(makeClient(routes), baseInput);
		expect(untrusted.ok).toBe(false);
		expect(untrusted.blocked.some((b) => b.includes("untrusted app id 99999"))).toBe(true);

		// (ii) empty trusted allowlist blocks fail-closed, even with a green run.
		const empty = await autoMergePreflight(makeClient(greenRoutes()), {
			...baseInput,
			trustedCheckAppIds: [],
		});
		expect(empty.ok).toBe(false);
		expect(empty.blocked.some((b) => b.includes("trusted check-run app allowlist is empty"))).toBe(true);
	});

	test("admin-perm bot token blocks; a thrown client error blocks fail-closed", async () => {
		// (i) admin permissions can bypass branch protection — block.
		const routes = greenRoutes();
		routes["GET /repos/o/r"] = { status: 200, json: { permissions: { push: true, admin: true, maintain: false } } };
		const adminPerm = await autoMergePreflight(makeClient(routes), baseInput);
		expect(adminPerm.ok).toBe(false);
		expect(adminPerm.blocked.some((b) => b.includes("bypass-capable permissions"))).toBe(true);

		// (ii) a thrown client error on any read must block, never propagate.
		const throwRoutes = greenRoutes();
		throwRoutes["GET /repos/o/r/pulls/7"] = { throw: "ECONNRESET" };
		const thrown = await autoMergePreflight(makeClient(throwRoutes), baseInput);
		expect(thrown.ok).toBe(false);
		expect(thrown.blocked.some((b) => b.includes("pr snapshot request failed"))).toBe(true);
	});
});
