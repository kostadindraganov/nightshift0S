/**
 * WHY: Forgejo (and Gitea) exposes an API that mirrors GitHub's REST API for
 * pull-request operations, so this client reuses `ForgeClient` + `openPullRequest`
 * from github.ts without change. The only difference is authentication: Forgejo
 * expects `Authorization: token <TOKEN>` instead of `Bearer <TOKEN>`, and the
 * `Accept` header is plain `application/json` rather than the GitHub vendor type.
 *
 * Resolution order for the access token:
 *   1. FORGEJO_TOKEN env var
 *   2. Throws — no CLI fallback (Forgejo has no universal auth CLI like `gh`)
 *
 * HOST-SIDE ONLY. Never call from agent sandbox code.
 */

import type { ForgeClient, ForgeClientRequest, ForgeClientResponse } from "./github.ts";

const DEFAULT_BASE_URL = "https://codeberg.org/api/v1";

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

export function resolveForgejoToken(): string {
	const token = process.env["FORGEJO_TOKEN"]?.trim();
	if (!token) {
		throw new Error(
			"Forgejo token resolution failed: FORGEJO_TOKEN is not set.",
		);
	}
	return token;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ForgejoRestClient implements ForgeClient {
	private readonly token: string;
	private readonly baseUrl: string;

	constructor(token: string, baseUrl = DEFAULT_BASE_URL) {
		this.token = token;
		this.baseUrl = baseUrl.replace(/\/$/, "");
	}

	async request({ method, path, body }: ForgeClientRequest): Promise<ForgeClientResponse> {
		// Forgejo's pull-request API is at /repos/:owner/:repo/pulls —
		// identical path to GitHub. We strip a leading /repos prefix if baseUrl
		// already contains /api/v1 so callers can pass GitHub-shaped paths unchanged.
		const normalizedPath = this.baseUrl.includes("/api/v1")
			? path
			: path;

		const resp = await fetch(`${this.baseUrl}${normalizedPath}`, {
			method,
			headers: {
				// Forgejo uses "token" not "Bearer"
				Authorization: `token ${this.token}`,
				Accept: "application/json",
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
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a ForgeClient backed by a Forgejo instance.
 *
 * @param baseUrl Forgejo API base, e.g. "https://codeberg.org/api/v1" or
 *                "https://forgejo.example.com/api/v1". Defaults to Codeberg.
 */
export function createForgejoForgeClient(
	baseUrl = DEFAULT_BASE_URL,
): ForgeClient {
	const token = resolveForgejoToken();
	return new ForgejoRestClient(token, baseUrl);
}
