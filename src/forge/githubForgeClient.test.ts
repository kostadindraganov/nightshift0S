/**
 * Hermetic tests for githubForgeClient — NO live fetch, NO live gh spawn.
 * All external I/O is stubbed via process.env mutation, a fake Spawner, and
 * a globalThis.fetch override.
 *
 * Cases:
 *   1. resolveGitHubToken returns env var when GITHUB_TOKEN is set
 *   2. resolveGitHubToken throws (fail-closed) when spawner returns non-zero exit
 *   3. GitHubRestClient.request builds correct Authorization + Accept headers
 *   4. GitHubRestClient.request serialises body as JSON and sets Content-Type
 */

import { describe, test, expect, afterEach } from "bun:test";
import { resolveGitHubToken } from "./githubForgeClient.ts";
import type { SpawnResult, Spawner } from "./githubForgeClient.ts";
import { GitHubRestClient } from "./github.ts";

// ---------------------------------------------------------------------------
// Helpers — fake Spawner
// ---------------------------------------------------------------------------

function makeSpawner(exitCode: number, stdout: string, stderr = ""): Spawner {
	return (_cmd: string[]): SpawnResult => {
		const enc = new TextEncoder();
		return {
			exited: Promise.resolve(exitCode),
			stdout: new ReadableStream({
				start(ctrl) { ctrl.enqueue(enc.encode(stdout)); ctrl.close(); },
			}),
			stderr: new ReadableStream({
				start(ctrl) { ctrl.enqueue(enc.encode(stderr)); ctrl.close(); },
			}),
		};
	};
}

// ---------------------------------------------------------------------------
// Helpers — fetch stub
// ---------------------------------------------------------------------------

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function installFetchStub(stub: FetchStub): () => void {
	const original = globalThis.fetch;
	// @ts-expect-error — intentional stub override in test context
	globalThis.fetch = stub;
	return () => { globalThis.fetch = original; };
}

// ---------------------------------------------------------------------------
// Case 1 — resolveGitHubToken reads GITHUB_TOKEN from env
// ---------------------------------------------------------------------------

describe("resolveGitHubToken", () => {
	const origToken = process.env["GITHUB_TOKEN"];

	afterEach(() => {
		if (origToken === undefined) {
			delete process.env["GITHUB_TOKEN"];
		} else {
			process.env["GITHUB_TOKEN"] = origToken;
		}
	});

	test("returns GITHUB_TOKEN env var immediately (spawner never called)", async () => {
		process.env["GITHUB_TOKEN"] = "ghp_env_token_xyz";
		// Pass a spawner that throws if called — to verify it is never invoked
		const neverCalled: Spawner = () => { throw new Error("spawner must not be called"); };
		const token = await resolveGitHubToken(neverCalled);
		expect(token).toBe("ghp_env_token_xyz");
	});

	// Case 2 — spawner returns exit 1 → must throw (fail-closed)
	test("throws when GITHUB_TOKEN unset and spawner returns non-zero exit", async () => {
		delete process.env["GITHUB_TOKEN"];
		const failSpawner = makeSpawner(1, "", "authentication required");
		await expect(resolveGitHubToken(failSpawner)).rejects.toThrow(
			/GitHub token resolution failed/,
		);
	});
});

// ---------------------------------------------------------------------------
// Case 3 — GitHubRestClient sets correct Authorization + Accept headers
// ---------------------------------------------------------------------------

describe("GitHubRestClient.request — header construction", () => {
	test("sends Bearer token, Accept: vnd.github+json, X-GitHub-Api-Version", async () => {
		let capturedRequest: Request | undefined;

		const restore = installFetchStub(async (input, init) => {
			capturedRequest = new Request(input as RequestInfo, init);
			return new Response(
				JSON.stringify({ number: 1, html_url: "https://github.com/o/r/pull/1" }),
				{ status: 201, headers: { "Content-Type": "application/json" } },
			);
		});

		try {
			const client = new GitHubRestClient("ghp_stubtoken", "https://api.github.com");
			await client.request({
				method: "POST",
				path: "/repos/o/r/pulls",
				body: { title: "T", body: "B", head: "h", base: "main" },
			});
		} finally {
			restore();
		}

		expect(capturedRequest).toBeDefined();
		expect(capturedRequest!.headers.get("Authorization")).toBe("Bearer ghp_stubtoken");
		expect(capturedRequest!.headers.get("Accept")).toBe("application/vnd.github+json");
		expect(capturedRequest!.headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
	});

	// Case 4 — body is JSON-serialised and Content-Type is set
	test("serialises body as JSON with Content-Type: application/json", async () => {
		let capturedBody: string | null = null;
		let capturedContentType: string | null = null;

		const restore = installFetchStub(async (_input, init) => {
			capturedBody = (init?.body as string | undefined) ?? null;
			capturedContentType = new Headers(init?.headers).get("Content-Type");
			return new Response(
				JSON.stringify({ number: 7, html_url: "https://github.com/o/r/pull/7" }),
				{ status: 201, headers: { "Content-Type": "application/json" } },
			);
		});

		const payload = { title: "My PR", body: "desc", head: "feature", base: "main" };

		try {
			const client = new GitHubRestClient("ghp_stubtoken", "https://api.github.com");
			await client.request({ method: "POST", path: "/repos/o/r/pulls", body: payload });
		} finally {
			restore();
		}

		expect(capturedContentType!).toBe("application/json");
		expect(JSON.parse(capturedBody!)).toEqual(payload);
	});
});
