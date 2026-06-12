/**
 * WHY: Auto-merge is V1.5 and gated (BLUEPRINT §3.12.1). Before EVERY merge
 * (§3.12.26 — not just at setup) we must independently re-prove that the merge
 * is safe: the base branch is actually protected, the required checks ran green
 * on the live head from a TRUSTED check-run app, the head has not moved since
 * the approving verdict bound to it (a new push invalidates approval —
 * SPEC-STATE-MACHINES §4), and the bot token cannot bypass protection.
 *
 * This module is FAIL-CLOSED: it NEVER throws. Every exception, undefined 404
 * semantics, non-2xx, or missing/odd-shaped field becomes a blocked[] reason.
 * All five checks are evaluated so the operator sees every reason; the merge
 * proceeds only when blocked.length === 0. Capabilities/protection are PROVEN
 * from live GitHub state, never assumed (§3.12.13/.30).
 *
 * All GitHub access is through the injected ForgeClient (src/forge/github.ts):
 * no live fetch, no token handling here. The agent worktree never holds a
 * token; only the host forge service does. Tests inject a fake client scripted
 * by REST path — no network.
 */

import type { ForgeClient } from "./github.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreflightInput {
	owner: string;
	repo: string;
	prNumber: number;
	/** Protected branch NAME (RepoConfig.defaultBranch) — not a SHA. */
	baseBranch: string;
	/** Locally-recorded PR head (from task.pr_opened / run row). */
	headSha: string;
	/** The SHA the approving verdict bound to (verdict thread event payload.headSha). */
	approvedSha: string;
	/** config forge.trustedCheckAppIds — EMPTY ⇒ check (b) blocks (fail-closed). */
	trustedCheckAppIds: number[];
}

export interface PreflightResult {
	ok: boolean;
	blocked: string[];
}

// ---------------------------------------------------------------------------
// Small helpers — keep each REST read defensive and fail-closed
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/**
 * Performs one REST read, catching any thrown client error and converting it
 * to a fail-closed result rather than propagating. Never throws.
 */
async function safeRequest(
	client: ForgeClient,
	method: string,
	path: string,
): Promise<{ status: number; json: unknown } | { error: string }> {
	try {
		const resp = await client.request({ method, path });
		return { status: resp.status, json: resp.json };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

// ---------------------------------------------------------------------------
// autoMergePreflight (§3.12.26)
// ---------------------------------------------------------------------------

/**
 * Runs the five fail-closed checks before a merge. Collects ALL block reasons
 * (operator visibility); ok === blocked.length === 0. Never throws.
 */
export async function autoMergePreflight(
	client: ForgeClient,
	input: PreflightInput,
): Promise<PreflightResult> {
	const { owner, repo, prNumber, baseBranch, approvedSha, headSha, trustedCheckAppIds } = input;
	const blocked: string[] = [];

	// -- Check 1: PR snapshot ------------------------------------------------
	// GET the PR; require open + base.ref === baseBranch; capture live head SHA.
	let liveHead: string | null = null;
	const prResp = await safeRequest(client, "GET", `/repos/${owner}/${repo}/pulls/${prNumber}`);
	if ("error" in prResp) {
		blocked.push(`pr snapshot request failed: ${prResp.error}`);
	} else if (prResp.status !== 200) {
		blocked.push(`pr snapshot returned ${prResp.status}`);
	} else if (!isRecord(prResp.json)) {
		blocked.push("pr snapshot has malformed body");
	} else {
		const pr = prResp.json;
		if (pr["state"] !== "open") {
			blocked.push(`pr is not open (state=${String(pr["state"])})`);
		}
		const base = pr["base"];
		const baseRef = isRecord(base) ? base["ref"] : undefined;
		if (baseRef !== baseBranch) {
			blocked.push(`pr base.ref ${String(baseRef)} !== ${baseBranch}`);
		}
		const head = pr["head"];
		const sha = isRecord(head) ? head["sha"] : undefined;
		if (typeof sha === "string" && sha.length > 0) {
			liveHead = sha;
		} else {
			blocked.push("pr head.sha missing");
		}
	}

	// -- Check (a): protection OR ruleset exists on baseBranch ---------------
	// Union the required-check contexts from classic protection and rulesets.
	const requiredNames = new Set<string>();
	let protectionFound = false;

	// Classic branch protection.
	const protResp = await safeRequest(
		client,
		"GET",
		`/repos/${owner}/${repo}/branches/${baseBranch}/protection`,
	);
	if ("error" in protResp) {
		blocked.push(`branch protection request failed: ${protResp.error}`);
	} else if (protResp.status === 200) {
		protectionFound = true;
		if (isRecord(protResp.json)) {
			const rsc = protResp.json["required_status_checks"];
			const contexts = isRecord(rsc) ? rsc["contexts"] : undefined;
			if (Array.isArray(contexts)) {
				for (const c of contexts) {
					if (typeof c === "string") requiredNames.add(c);
				}
			}
		}
	} else if (protResp.status !== 404) {
		// 404 = no classic protection (not an error). Anything else is uncertain.
		blocked.push(`branch protection returned ${protResp.status}`);
	}

	// Rulesets.
	const rulesResp = await safeRequest(
		client,
		"GET",
		`/repos/${owner}/${repo}/rules/branches/${baseBranch}`,
	);
	if ("error" in rulesResp) {
		blocked.push(`branch rules request failed: ${rulesResp.error}`);
	} else if (rulesResp.status === 200) {
		if (Array.isArray(rulesResp.json) && rulesResp.json.length > 0) {
			protectionFound = true;
			for (const rule of rulesResp.json) {
				if (!isRecord(rule) || rule["type"] !== "required_status_checks") continue;
				const params = rule["parameters"];
				const checks = isRecord(params) ? params["required_status_checks"] : undefined;
				if (Array.isArray(checks)) {
					for (const chk of checks) {
						const ctx = isRecord(chk) ? chk["context"] : undefined;
						if (typeof ctx === "string") requiredNames.add(ctx);
					}
				}
			}
		}
		// 200 + empty array ⇒ no active rules (not an error).
	} else if (rulesResp.status !== 404) {
		blocked.push(`branch rules returned ${rulesResp.status}`);
	}

	if (!protectionFound) {
		blocked.push(`no branch protection or ruleset on ${baseBranch}`);
	}

	// -- Check (b): required checks from TRUSTED apps are green on liveHead ---
	if (protectionFound) {
		if (requiredNames.size === 0) {
			blocked.push("no required status checks configured");
		} else if (trustedCheckAppIds.length === 0) {
			blocked.push("trusted check-run app allowlist is empty");
		} else if (liveHead === null) {
			// Can't fetch check runs without a head we trust we read.
			blocked.push("cannot verify required checks: live head unknown");
		} else {
			const crResp = await safeRequest(
				client,
				"GET",
				`/repos/${owner}/${repo}/commits/${liveHead}/check-runs`,
			);
			if ("error" in crResp) {
				blocked.push(`check-runs request failed: ${crResp.error}`);
			} else if (crResp.status !== 200) {
				blocked.push(`check-runs returned ${crResp.status}`);
			} else {
				const body = crResp.json;
				const runs =
					isRecord(body) && Array.isArray(body["check_runs"]) ? body["check_runs"] : [];
				for (const name of requiredNames) {
					const match = runs.find(
						(r) => isRecord(r) && r["name"] === name,
					);
					if (!isRecord(match)) {
						blocked.push(`required check "${name}" has no check run`);
						continue;
					}
					if (match["conclusion"] !== "success") {
						blocked.push(
							`required check "${name}" not success (conclusion=${String(match["conclusion"])})`,
						);
						continue;
					}
					const app = match["app"];
					const appId = isRecord(app) ? app["id"] : undefined;
					if (typeof appId !== "number") {
						blocked.push(`required check "${name}" missing app.id`);
						continue;
					}
					if (!trustedCheckAppIds.includes(appId)) {
						blocked.push(`required check "${name}" from untrusted app id ${appId}`);
					}
				}
			}
		}
	}

	// -- Check (c): head is FRESH (live === approved === local) --------------
	// A newer push since approval invalidates the verdict (SPEC §4).
	if (liveHead === null) {
		blocked.push("cannot verify head freshness: live head unknown");
	} else if (liveHead !== approvedSha || liveHead !== headSha) {
		blocked.push(`head moved since approval: live=${liveHead} approved=${approvedSha}`);
	}

	// -- Check (d): bot token has NO bypass-capable permissions --------------
	const repoResp = await safeRequest(client, "GET", `/repos/${owner}/${repo}`);
	if ("error" in repoResp) {
		blocked.push(`repo metadata request failed: ${repoResp.error}`);
	} else if (repoResp.status !== 200) {
		blocked.push(`repo metadata returned ${repoResp.status}`);
	} else {
		const perms = isRecord(repoResp.json) ? repoResp.json["permissions"] : undefined;
		if (!isRecord(perms)) {
			// Uncertainty blocks.
			blocked.push("repo metadata missing permissions object");
		} else if (perms["admin"] === true || perms["maintain"] === true) {
			blocked.push("bot token has bypass-capable permissions");
		}
	}

	return { ok: blocked.length === 0, blocked };
}
