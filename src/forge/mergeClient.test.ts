/**
 * Tests for mergePullRequest — FAIL-CLOSED squash merge via injected client.
 * No network: the ForgeClient is a fake returning canned merge responses. ≤3:
 *   - 200 + merged:true + sha → {merged:true, mergeSha}, correct request shape
 *   - 409 (head mismatch) → {merged:false}
 *   - malformed body / merged:false → {merged:false}, never throws
 */

import { describe, test, expect } from "bun:test";
import { mergePullRequest } from "./mergeClient.ts";
import type { ForgeClient, ForgeClientRequest, ForgeClientResponse } from "./github.ts";

function makeClient(
	resp: ForgeClientResponse,
): { client: ForgeClient; state: { lastReq: ForgeClientRequest | null } } {
	const state = { lastReq: null as ForgeClientRequest | null };
	const client: ForgeClient = {
		async request(req: ForgeClientRequest): Promise<ForgeClientResponse> {
			state.lastReq = req;
			return resp;
		},
	};
	return { client, state };
}

const input = { owner: "o", repo: "r", prNumber: 7, sha: "deadbeef" } as const;

describe("mergePullRequest", () => {
	test("200 merged → mergeSha and a PUT squash request", async () => {
		const { client, state } = makeClient({
			status: 200,
			json: { merged: true, sha: "mergecommit123" },
		});
		const result = await mergePullRequest(client, input);
		expect(result).toEqual({ merged: true, mergeSha: "mergecommit123" });
		expect(state.lastReq?.method).toBe("PUT");
		expect(state.lastReq?.path).toBe("/repos/o/r/pulls/7/merge");
		expect(state.lastReq?.body).toEqual({ sha: "deadbeef", merge_method: "squash" });
	});

	test("409 head mismatch → merged:false", async () => {
		const { client } = makeClient({ status: 409, json: { message: "Head branch was modified" } });
		const result = await mergePullRequest(client, input);
		expect(result.merged).toBe(false);
	});

	test("malformed / merged:false body → merged:false, never throws", async () => {
		const { client } = makeClient({ status: 200, json: { merged: false } });
		const result = await mergePullRequest(client, input);
		expect(result.merged).toBe(false);
	});
});
