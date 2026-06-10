/**
 * WHY: The agent worktree NEVER holds a GitHub token — only the host forge
 * service does. This module defines an injectable ForgeClient interface so
 * the PR-open logic can be unit-tested with a fake client without any network
 * access. The real client (using fetch + a host-held token) is a thin wrapper
 * that satisfies the same interface (§2.6 / BLUEPRINT §3.12.25 threat model).
 *
 * DEPLOY-PENDING: live openPullRequest requires a real GITHUB_TOKEN env var
 * on the host. Tests inject a fake ForgeClient.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForgeClientRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface ForgeClientResponse {
  status: number;
  json: unknown;
}

/** Injectable GitHub REST client. Tests supply a fake; production uses GitHubRestClient. */
export interface ForgeClient {
  request(req: ForgeClientRequest): Promise<ForgeClientResponse>;
}

export interface OpenPrArgs {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface PrResult {
  number: number;
  url: string;
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

/**
 * Builds the REST request object for opening a pull request.
 * Kept pure so tests can assert the shape without going over the network.
 */
export function buildOpenPrRequest({
  owner,
  repo,
  head,
  base,
  title,
  body,
}: OpenPrArgs): { method: "POST"; path: string; body: object } {
  return {
    method: "POST",
    path: `/repos/${owner}/${repo}/pulls`,
    body: { title, body, head, base },
  };
}

// ---------------------------------------------------------------------------
// Open PR
// ---------------------------------------------------------------------------

/**
 * Opens a pull request via the injected ForgeClient and returns the PR number
 * and HTML URL. Throws on non-2xx responses with a descriptive message.
 *
 * DEPLOY-PENDING: requires a real host-held token in the production client.
 */
export async function openPullRequest(
  client: ForgeClient,
  args: OpenPrArgs,
): Promise<PrResult> {
  const req = buildOpenPrRequest(args);
  const resp = await client.request(req);

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(
      `GitHub API error: POST ${req.path} returned ${resp.status}: ${JSON.stringify(resp.json)}`,
    );
  }

  const data = resp.json as Record<string, unknown>;
  const number = data["number"];
  const url = data["html_url"];

  if (typeof number !== "number" || typeof url !== "string") {
    throw new Error(
      `Unexpected GitHub PR response shape: ${JSON.stringify(resp.json)}`,
    );
  }

  return { number, url };
}

// ---------------------------------------------------------------------------
// Real client (host-only, DEPLOY-PENDING)
// ---------------------------------------------------------------------------

/**
 * Thin production ForgeClient backed by fetch + a host-held GitHub token.
 * Instantiate with `new GitHubRestClient(token)` on the host only.
 * The agent worktree NEVER has access to this class or its token.
 *
 * DEPLOY-PENDING: wire up when live GitHub integration is needed.
 */
export class GitHubRestClient implements ForgeClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, baseUrl = "https://api.github.com") {
    this.token = token;
    this.baseUrl = baseUrl;
  }

  async request({ method, path, body }: ForgeClientRequest): Promise<ForgeClientResponse> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
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
