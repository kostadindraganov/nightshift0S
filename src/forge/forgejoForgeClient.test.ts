/**
 * Hermetic tests for forgejoForgeClient + gitlabForgeClient + forgeFactory.
 * No live fetch, no env side-effects beyond the test scope.
 *
 * Cases:
 *   Forgejo:
 *     1. resolveForgejoToken returns FORGEJO_TOKEN env var
 *     2. resolveForgejoToken throws when FORGEJO_TOKEN unset
 *     3. ForgejoRestClient uses "Authorization: token <token>" header
 *     4. openPullRequest (reused from github.ts) works through ForgejoRestClient
 *   GitLab:
 *     5. resolveGitLabToken returns GITLAB_TOKEN env var
 *     6. resolveGitLabToken throws when GITLAB_TOKEN unset
 *     7. GitLabRestClient uses "PRIVATE-TOKEN" header
 *     8. buildOpenMrRequest maps head/base → source_branch/target_branch
 *     9. openMergeRequest maps iid + web_url → PrResult
 *  Factory:
 *    10. createForgeService("forgejo") returns ForgeService
 *    11. createForgeService("gitlab") returns ForgeService
 *    12. createForgeService("unknown") throws
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { resolveForgejoToken, ForgejoRestClient } from "./forgejoForgeClient.ts";
import { resolveGitLabToken, GitLabRestClient, buildOpenMrRequest, openMergeRequest } from "./gitlabForgeClient.ts";
import { openPullRequest } from "./github.ts";
import type { ForgeClientResponse } from "./github.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function installFetchStub(stub: FetchStub): () => void {
	const original = globalThis.fetch;
	// @ts-expect-error — intentional stub override in test context
	globalThis.fetch = stub;
	return () => { globalThis.fetch = original; };
}

function makeFetchStub(status: number, body: unknown): FetchStub {
	return async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
}

function envGuard(key: string) {
	const orig = process.env[key];
	return () => {
		if (orig === undefined) delete process.env[key];
		else process.env[key] = orig;
	};
}

// ---------------------------------------------------------------------------
// Forgejo — token resolution
// ---------------------------------------------------------------------------

describe("resolveForgejoToken", () => {
	let restore: () => void;
	beforeEach(() => { restore = envGuard("FORGEJO_TOKEN"); });
	afterEach(() => restore());

	test("returns FORGEJO_TOKEN env var", () => {
		process.env["FORGEJO_TOKEN"] = "fgj_test_abc";
		expect(resolveForgejoToken()).toBe("fgj_test_abc");
	});

	test("throws when FORGEJO_TOKEN is unset", () => {
		delete process.env["FORGEJO_TOKEN"];
		expect(() => resolveForgejoToken()).toThrow(/FORGEJO_TOKEN is not set/);
	});
});

// ---------------------------------------------------------------------------
// ForgejoRestClient — request shape
// ---------------------------------------------------------------------------

describe("ForgejoRestClient", () => {
	test("sets Authorization: token <token> header", async () => {
		let capturedHeaders: HeadersInit | undefined;
		const restore = installFetchStub(async (_url, init) => {
			capturedHeaders = init?.headers;
			return new Response(JSON.stringify({}), { status: 200 });
		});
		try {
			const client = new ForgejoRestClient("fgj_tok", "https://codeberg.org/api/v1");
			await client.request({ method: "GET", path: "/user" });
			const headers = capturedHeaders as Record<string, string>;
			expect(headers["Authorization"]).toBe("token fgj_tok");
			expect(headers["Accept"]).toBe("application/json");
		} finally {
			restore();
		}
	});

	test("openPullRequest works through ForgejoRestClient", async () => {
		const prPayload = { number: 42, html_url: "https://codeberg.org/org/repo/pulls/42" };
		const restore = installFetchStub(makeFetchStub(201, prPayload));
		try {
			const client = new ForgejoRestClient("fgj_tok", "https://codeberg.org/api/v1");
			const result = await openPullRequest(client, {
				owner: "org", repo: "repo", head: "feat", base: "main",
				title: "My PR", body: "Description",
			});
			expect(result.number).toBe(42);
			expect(result.url).toBe("https://codeberg.org/org/repo/pulls/42");
		} finally {
			restore();
		}
	});
});

// ---------------------------------------------------------------------------
// GitLab — token resolution
// ---------------------------------------------------------------------------

describe("resolveGitLabToken", () => {
	let restore: () => void;
	beforeEach(() => { restore = envGuard("GITLAB_TOKEN"); });
	afterEach(() => restore());

	test("returns GITLAB_TOKEN env var", () => {
		process.env["GITLAB_TOKEN"] = "glpat-xyz";
		expect(resolveGitLabToken()).toBe("glpat-xyz");
	});

	test("throws when GITLAB_TOKEN is unset", () => {
		delete process.env["GITLAB_TOKEN"];
		expect(() => resolveGitLabToken()).toThrow(/GITLAB_TOKEN is not set/);
	});
});

// ---------------------------------------------------------------------------
// GitLabRestClient — request shape
// ---------------------------------------------------------------------------

describe("GitLabRestClient", () => {
	test("sets PRIVATE-TOKEN header (not Authorization)", async () => {
		let capturedHeaders: HeadersInit | undefined;
		const restore = installFetchStub(async (_url, init) => {
			capturedHeaders = init?.headers;
			return new Response(JSON.stringify({}), { status: 200 });
		});
		try {
			const client = new GitLabRestClient("glpat-tok");
			await client.request({ method: "GET", path: "/api/v4/user" });
			const headers = capturedHeaders as Record<string, string>;
			expect(headers["PRIVATE-TOKEN"]).toBe("glpat-tok");
			expect(headers["Authorization"]).toBeUndefined();
		} finally {
			restore();
		}
	});
});

// ---------------------------------------------------------------------------
// buildOpenMrRequest
// ---------------------------------------------------------------------------

describe("buildOpenMrRequest", () => {
	test("maps head/base to source_branch/target_branch and encodes project path", () => {
		const req = buildOpenMrRequest({
			owner: "myorg", repo: "my-repo", head: "feat/x", base: "main",
			title: "Add feature", body: "Details",
		});
		expect(req.method).toBe("POST");
		expect(req.path).toContain("myorg%2Fmy-repo");
		expect(req.path).toContain("/merge_requests");
		const b = req.body as Record<string, unknown>;
		expect(b["source_branch"]).toBe("feat/x");
		expect(b["target_branch"]).toBe("main");
		expect(b["title"]).toBe("Add feature");
		expect(b["description"]).toBe("Details");
	});
});

// ---------------------------------------------------------------------------
// openMergeRequest
// ---------------------------------------------------------------------------

describe("openMergeRequest", () => {
	test("maps iid + web_url to PrResult", async () => {
		const mrPayload = { iid: 7, web_url: "https://gitlab.com/org/repo/-/merge_requests/7" };
		const restore = installFetchStub(makeFetchStub(201, mrPayload));
		try {
			const client = new GitLabRestClient("glpat-tok");
			const result = await openMergeRequest(client, {
				owner: "org", repo: "repo", head: "feat", base: "main",
				title: "MR title", body: "MR body",
			});
			expect(result.number).toBe(7);
			expect(result.url).toBe("https://gitlab.com/org/repo/-/merge_requests/7");
		} finally {
			restore();
		}
	});

	test("throws on non-2xx GitLab response", async () => {
		const restore = installFetchStub(makeFetchStub(422, { message: "Branch not found" }));
		try {
			const client = new GitLabRestClient("glpat-tok");
			await expect(
				openMergeRequest(client, {
					owner: "org", repo: "repo", head: "feat", base: "main",
					title: "T", body: "B",
				}),
			).rejects.toThrow(/GitLab API error.*422/);
		} finally {
			restore();
		}
	});

	test("throws on unexpected response shape", async () => {
		const restore = installFetchStub(makeFetchStub(201, { id: 99 }));
		try {
			const client = new GitLabRestClient("glpat-tok");
			await expect(
				openMergeRequest(client, {
					owner: "org", repo: "repo", head: "feat", base: "main",
					title: "T", body: "B",
				}),
			).rejects.toThrow(/Unexpected GitLab MR response/);
		} finally {
			restore();
		}
	});
});

// ---------------------------------------------------------------------------
// forgeFactory
// ---------------------------------------------------------------------------

describe("createForgeService (forgeFactory)", () => {
	let restoreF: () => void;
	let restoreG: () => void;
	let restoreH: () => void;

	beforeEach(() => {
		restoreF = envGuard("FORGEJO_TOKEN");
		restoreG = envGuard("GITLAB_TOKEN");
		restoreH = envGuard("GITHUB_TOKEN");
	});
	afterEach(() => { restoreF(); restoreG(); restoreH(); });

	test("forgejo provider creates service with openPr using github-shaped path", async () => {
		process.env["FORGEJO_TOKEN"] = "fgj_tok";
		const { createForgeService } = await import("./forgeFactory.ts");
		const svc = await createForgeService({ provider: "forgejo" });
		expect(svc.client).toBeDefined();
		expect(typeof svc.openPr).toBe("function");
	});

	test("gitlab provider creates service", async () => {
		process.env["GITLAB_TOKEN"] = "glpat-tok";
		const { createForgeService } = await import("./forgeFactory.ts");
		const svc = await createForgeService({ provider: "gitlab" });
		expect(svc.client).toBeDefined();
		expect(typeof svc.openPr).toBe("function");
	});

	test("github provider creates service (using GITHUB_TOKEN)", async () => {
		process.env["GITHUB_TOKEN"] = "ghp_tok";
		const { createForgeService } = await import("./forgeFactory.ts");
		const svc = await createForgeService({ provider: "github" });
		expect(svc.client).toBeDefined();
		expect(typeof svc.openPr).toBe("function");
	});

	test("unknown provider throws", async () => {
		const { createForgeService } = await import("./forgeFactory.ts");
		await expect(createForgeService({ provider: "bitbucket" })).rejects.toThrow(
			/Unsupported forge provider "bitbucket"/,
		);
	});
});
