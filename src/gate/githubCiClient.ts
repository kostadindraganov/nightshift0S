/**
 * WHY: The live GitHub Checks API implementation of CiClient (ci.ts).
 *
 * Token is resolved host-side only — never from the agent worktree — mirroring
 * the forge/github.ts threat model (§3.12.25).  Resolution order:
 *   1. GITHUB_TOKEN environment variable
 *   2. `gh auth token` CLI (GitHub CLI, must be installed and logged in)
 *
 * A missing/empty token THROWS rather than silently no-oping (fail-closed).
 *
 * Mapped fields from GitHub's check_runs payload:
 *   name       → CheckRun.name
 *   conclusion → CheckRun.status when not null
 *   status     → CheckRun.status when conclusion is null ("queued"/"in_progress" → "pending")
 */

import { spawnSync } from "node:child_process";
import type { CiClient, CheckRun, CheckStatus } from "./ci.ts";

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a GitHub token from the environment or the `gh` CLI.
 * Throws if neither source yields a non-empty token.
 */
export function resolveGitHubToken(): string {
	const env = process.env["GITHUB_TOKEN"];
	if (env && env.trim().length > 0) {
		return env.trim();
	}

	// Fall back to `gh auth token` — synchronous so it can be used at
	// construction time without async plumbing.
	const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
	const ghToken = result.stdout?.trim();

	if (result.status === 0 && ghToken && ghToken.length > 0) {
		return ghToken;
	}

	throw new Error(
		"No GitHub token found: set GITHUB_TOKEN or run `gh auth login`",
	);
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

/**
 * GitHub's API returns conclusion and status as separate fields.
 * Conclusion is set only when the run has finished; status covers in-progress runs.
 *
 * Maps to our CheckStatus subset:
 *   conclusion "success"          → "success"
 *   conclusion "neutral"          → "neutral"
 *   conclusion "skipped"          → "skipped"
 *   conclusion "failure"          → "failure"
 *   conclusion "timed_out"        → "failure"
 *   conclusion "action_required"  → "failure"
 *   conclusion "cancelled"        → "failure"
 *   conclusion "stale"            → "failure"
 *   conclusion null (in-progress) → derived from status field → "pending"
 *   anything else                 → "pending"
 */
export function mapConclusion(
	conclusion: string | null,
	_status: string,
): CheckStatus {
	switch (conclusion) {
		case "success":
			return "success";
		case "neutral":
			return "neutral";
		case "skipped":
			return "skipped";
		case "failure":
		case "timed_out":
		case "action_required":
		case "cancelled":
		case "stale":
			return "failure";
		case null:
		default:
			// Conclusion is null when the run is still queued or in_progress.
			return "pending";
	}
}

/** Shape of one element in GitHub's check_runs array (fields we care about). */
export interface GitHubCheckRun {
	name: string;
	status: string;
	conclusion: string | null;
}

/** Shape of the GET .../check-runs response envelope. */
export interface GitHubCheckRunsResponse {
	check_runs: GitHubCheckRun[];
}

/**
 * Parse the `next` URL out of a GitHub `Link` response header.
 *
 * The header looks like:
 *   <https://api.github.com/...&page=2>; rel="next", <...&page=5>; rel="last"
 *
 * Returns the URL inside the `rel="next"` segment, or null when there is no
 * next page (last page reached, or header absent). Pure — safe to unit test.
 */
export function parseNextLink(linkHeader: string | null): string | null {
	if (!linkHeader) return null;
	for (const part of linkHeader.split(",")) {
		const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
		if (match) return match[1] ?? null;
	}
	return null;
}

/**
 * Maps a raw GitHub check_runs API response to our CheckRun[] type.
 * Pure function — safe to test without any network calls.
 */
export function mapCheckRuns(response: GitHubCheckRunsResponse): CheckRun[] {
	return response.check_runs.map((run) => ({
		name: run.name,
		status: mapConclusion(run.conclusion, run.status),
	}));
}

// ---------------------------------------------------------------------------
// Live client
// ---------------------------------------------------------------------------

/**
 * Production CiClient that polls the GitHub Checks API.
 * Instantiate with owner/repo on the host only; never inside an agent worktree.
 */
export class GitHubCiClient implements CiClient {
	private readonly owner: string;
	private readonly repo: string;
	private readonly token: string;
	private readonly baseUrl: string;

	constructor(
		owner: string,
		repo: string,
		token?: string,
		baseUrl = "https://api.github.com",
	) {
		this.owner = owner;
		this.repo = repo;
		// Resolve token at construction time — throws if unavailable (fail-closed).
		this.token = token ?? resolveGitHubToken();
		this.baseUrl = baseUrl;
	}

	/**
	 * Fetches ALL check runs for the given ref from GitHub and maps them to
	 * CheckRun[]. Throws on non-2xx responses.
	 *
	 * Pins `?per_page=100` (LIVE-WIRING D3) and follows the `Link: rel="next"`
	 * header until exhausted, concatenating `check_runs` across pages. Without
	 * this, a required check that lands on page 2+ (>30, GitHub's default page
	 * size) is absent from the result and the CI gate falsely reports it
	 * `(missing)`, wedging a green PR into needs_human.
	 */
	async fetchChecks(ref: string): Promise<CheckRun[]> {
		let url:
			| string
			| null = `${this.baseUrl}/repos/${this.owner}/${this.repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`;

		const all: GitHubCheckRun[] = [];
		while (url !== null) {
			const resp = await fetch(url, {
				headers: {
					Authorization: `Bearer ${this.token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});

			if (!resp.ok) {
				throw new Error(
					`GitHub Checks API error: GET ${url} returned ${resp.status}`,
				);
			}

			const data = (await resp.json()) as GitHubCheckRunsResponse;
			all.push(...data.check_runs);

			url = parseNextLink(resp.headers.get("link"));
		}

		return mapCheckRuns({ check_runs: all });
	}
}
