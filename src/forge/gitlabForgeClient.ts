/**
 * WHY: GitLab's REST API for merge requests differs from GitHub's in three
 * important ways:
 *   1. Auth header: `PRIVATE-TOKEN: <token>` (not `Authorization: Bearer`).
 *   2. API path: `/api/v4/projects/:namespace%2F:repo/merge_requests`
 *      (namespace and repo are slash-joined then percent-encoded).
 *   3. Field names differ: `source_branch`/`target_branch` instead of
 *      `head`/`base`; response key is `iid` (not `number`), URL is `web_url`.
 *
 * This module provides a GitLab-specific `ForgeClient` plus a
 * `openMergeRequest` helper that mirrors `openPullRequest` from github.ts but
 * maps the field names correctly. Callers that need forge-agnostic PR creation
 * should use `forgeFactory.ts` which dispatches to the right helper.
 *
 * Token resolution: GITLAB_TOKEN env var only (GitLab has no universal CLI
 * equivalent of `gh auth token`).
 *
 * HOST-SIDE ONLY. Never call from agent sandbox code.
 */

import type { ForgeClient, ForgeClientRequest, ForgeClientResponse, OpenPrArgs, PrResult } from "./github.ts";

const DEFAULT_BASE_URL = "https://gitlab.com";

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

export function resolveGitLabToken(): string {
	const token = process.env["GITLAB_TOKEN"]?.trim();
	if (!token) {
		throw new Error(
			"GitLab token resolution failed: GITLAB_TOKEN is not set.",
		);
	}
	return token;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GitLabRestClient implements ForgeClient {
	private readonly token: string;
	private readonly baseUrl: string;

	constructor(token: string, baseUrl = DEFAULT_BASE_URL) {
		this.token = token;
		this.baseUrl = baseUrl.replace(/\/$/, "");
	}

	async request({ method, path, body }: ForgeClientRequest): Promise<ForgeClientResponse> {
		const resp = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: {
				"PRIVATE-TOKEN": this.token,
				"Content-Type": "application/json",
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});

		let json: unknown;
		try {
			json = await resp.json();
		} catch {
			json = null;
		}

		return { status: resp.status, json };
	}
}

// ---------------------------------------------------------------------------
// MR creation helper (GitLab-shaped equivalent of openPullRequest)
// ---------------------------------------------------------------------------

/**
 * Builds the REST request object for opening a GitLab merge request.
 * `owner` + `repo` are combined as `{owner}%2F{repo}` in the project path.
 */
export function buildOpenMrRequest({
	owner,
	repo,
	head,
	base,
	title,
	body,
}: OpenPrArgs): { method: "POST"; path: string; body: object } {
	const projectPath = encodeURIComponent(`${owner}/${repo}`);
	return {
		method: "POST",
		path: `/api/v4/projects/${projectPath}/merge_requests`,
		body: {
			source_branch: head,
			target_branch: base,
			title,
			description: body,
			remove_source_branch: false,
		},
	};
}

/**
 * Opens a GitLab merge request via the injected client.
 * Returns `{ number, url }` matching `PrResult` from github.ts —
 * `number` is the MR `iid` (project-scoped integer).
 */
export async function openMergeRequest(
	client: ForgeClient,
	args: OpenPrArgs,
): Promise<PrResult> {
	const req = buildOpenMrRequest(args);
	const resp = await client.request(req);

	if (resp.status < 200 || resp.status >= 300) {
		throw new Error(
			`GitLab API error: POST ${req.path} returned ${resp.status}: ${JSON.stringify(resp.json)}`,
		);
	}

	const data = resp.json as Record<string, unknown>;
	const iid = data["iid"];
	const url = data["web_url"];

	if (typeof iid !== "number" || typeof url !== "string") {
		throw new Error(
			`Unexpected GitLab MR response shape: ${JSON.stringify(resp.json)}`,
		);
	}

	return { number: iid, url };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a ForgeClient backed by a GitLab instance.
 *
 * @param baseUrl GitLab instance URL, e.g. "https://gitlab.com" or
 *                "https://gitlab.example.com". Defaults to gitlab.com.
 */
export function createGitLabForgeClient(
	baseUrl = DEFAULT_BASE_URL,
): ForgeClient {
	const token = resolveGitLabToken();
	return new GitLabRestClient(token, baseUrl);
}
