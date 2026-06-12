/**
 * WHY: The actual squash merge (V1.5 — the only merge_method we ship,
 * BLUEPRINT §3.12.1) lives behind the same injectable ForgeClient seam as the
 * preflight, so the merge can be exercised on macOS with a fake client and no
 * GitHub token (the host forge service holds the token, never the worktree).
 *
 * FAIL-CLOSED and NEVER throws: merged:true is returned ONLY on an
 * unambiguous success (200 + json.merged === true + a string merge-commit sha).
 * Every other outcome — 405 not mergeable, 409 head mismatch (GitHub
 * re-validates `sha` server-side as defense in depth), 404, malformed JSON, or
 * a thrown client error — becomes {merged:false, reason}. A merge whose result
 * we cannot positively confirm must be treated as NOT merged.
 */

import type { ForgeClient } from "./github.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MergeInput {
	owner: string;
	repo: string;
	prNumber: number;
	/** Expected head — GitHub re-validates server-side and 409s on mismatch (defense in depth). */
	sha: string;
	method?: "squash"; // default and only V1.5 value
}

export type MergeResult =
	| { merged: true; mergeSha: string }
	| { merged: false; reason: string };

// ---------------------------------------------------------------------------
// mergePullRequest
// ---------------------------------------------------------------------------

/**
 * Performs the squash merge via the injected ForgeClient. Never throws —
 * any failure or uncertain result is reported as {merged:false, reason}.
 */
export async function mergePullRequest(
	client: ForgeClient,
	input: MergeInput,
): Promise<MergeResult> {
	const { owner, repo, prNumber, sha } = input;
	const path = `/repos/${owner}/${repo}/pulls/${prNumber}/merge`;

	let resp: { status: number; json: unknown };
	try {
		resp = await client.request({
			method: "PUT",
			path,
			body: { sha, merge_method: input.method ?? "squash" },
		});
	} catch (err) {
		return { merged: false, reason: `merge request failed: ${err instanceof Error ? err.message : String(err)}` };
	}

	if (resp.status !== 200) {
		return { merged: false, reason: `merge returned ${resp.status}: ${JSON.stringify(resp.json)}` };
	}

	const json = resp.json;
	if (typeof json !== "object" || json === null) {
		return { merged: false, reason: "merge response has malformed body" };
	}

	const data = json as Record<string, unknown>;
	if (data["merged"] !== true) {
		return { merged: false, reason: `merge response merged !== true: ${JSON.stringify(json)}` };
	}

	const mergeSha = data["sha"];
	if (typeof mergeSha !== "string" || mergeSha.length === 0) {
		return { merged: false, reason: "merge response missing sha" };
	}

	return { merged: true, mergeSha };
}
