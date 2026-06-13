/**
 * CMA driver unit tests — hermetic, no live network.
 *
 * All tests inject a fake fetch so no real HTTP calls are made. The api key
 * is asserted to be present in the outgoing header but NEVER in stdout / errors.
 */

import { describe, it, expect } from "bun:test";
import { makeCmaDriver } from "./cma.ts";
import type { FetchFn } from "./cma.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake fetch that returns a canned JSON body. */
function fakeFetch(
	body: Record<string, unknown>,
	status = 200,
): { fn: FetchFn; calls: Array<{ url: string; init?: RequestInit }> } {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fn: FetchFn = async (url, init) => {
		calls.push({ url, init });
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	};
	return { fn, calls };
}

// ---------------------------------------------------------------------------
// 1. runOnce throws on empty model (fail-closed)
// ---------------------------------------------------------------------------

describe("cma driver", () => {
	it("runOnce throws when model is empty string", async () => {
		const { fn } = fakeFetch({ content: [], id: "x" });
		const driver = makeCmaDriver({ fetch: fn, model: "", apiKey: "sk-test" });
		await expect(driver.runOnce({ prompt: "hello" })).rejects.toThrow(
			"cma: model not configured",
		);
	});

	// -------------------------------------------------------------------------
	// 2. runOnce posts, parses text + usage; api key in header, NOT in stdout
	// -------------------------------------------------------------------------

	it("runOnce posts and parses text + usage; api key never in stdout", async () => {
		const SECRET = "sk-secret-key-value";
		const { fn, calls } = fakeFetch({
			id: "msg_abc",
			session_id: "sess_xyz",
			content: [{ type: "text", text: "Hello from CMA!" }],
			usage: { input_tokens: 12, output_tokens: 34 },
			cost_usd: 0.0005,
		});

		const driver = makeCmaDriver({ fetch: fn, model: "claude-opus-4-5", apiKey: SECRET });
		const result = await driver.runOnce({ prompt: "hi" });

		// Text parsed correctly
		expect(result.stdout).toBe("Hello from CMA!");

		// Telemetry parsed
		expect(result.tokensIn).toBe(12);
		expect(result.tokensOut).toBe(34);
		expect(result.costUsd).toBe(0.0005);

		// sessionId is the managed-session id (session_id preferred over id)
		expect(result.sessionId).toBe("sess_xyz");

		// API key is in the outgoing header
		const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
		expect(headers?.["x-api-key"]).toBe(SECRET);

		// API key NEVER appears in stdout
		expect(result.stdout).not.toContain(SECRET);
	});

	// -------------------------------------------------------------------------
	// 3. isAvailable: false when key OR model missing; true when both present
	// -------------------------------------------------------------------------

	it("isAvailable returns false when api key is missing", async () => {
		const { fn } = fakeFetch({});
		const driver = makeCmaDriver({ fetch: fn, model: "claude-opus-4-5", apiKey: undefined });
		expect(await driver.isAvailable()).toBe(false);
	});

	it("isAvailable returns false when model is empty", async () => {
		const { fn } = fakeFetch({});
		const driver = makeCmaDriver({ fetch: fn, model: "", apiKey: "sk-x" });
		expect(await driver.isAvailable()).toBe(false);
	});

	it("isAvailable returns true when both model and api key are present", async () => {
		const { fn } = fakeFetch({});
		const driver = makeCmaDriver({ fetch: fn, model: "claude-opus-4-5", apiKey: "sk-x" });
		expect(await driver.isAvailable()).toBe(true);
	});

	// -------------------------------------------------------------------------
	// 4. declared.structured_output is true but UNTRUSTED (XML probe required)
	// -------------------------------------------------------------------------
	// This is a declaration test: we assert the field is true to document the
	// UNTRUSTED stance. The conformance probe decides whether it is actually proven.

	it("declared.structured_output is true (UNTRUSTED — conformance probe required)", () => {
		const { fn } = fakeFetch({});
		const driver = makeCmaDriver({ fetch: fn, model: "claude-opus-4-5", apiKey: "sk-x" });
		// true = driver claims the capability; the probe may still fail it.
		expect(driver.declared.structured_output).toBe(true);
		// Document the contract: the value is a hypothesis, not a guarantee.
		expect(driver.declared.resume).toBe(true);
	});

	// -------------------------------------------------------------------------
	// 5. resumeOnce calls the session-scoped endpoint with sessionId in the path
	// -------------------------------------------------------------------------

	it("resumeOnce posts to the session endpoint and returns stdout", async () => {
		const { fn, calls } = fakeFetch({
			content: [{ type: "text", text: "session continuation" }],
		});
		const driver = makeCmaDriver({ fetch: fn, model: "claude-opus-4-5", apiKey: "sk-x" });
		const result = await driver.resumeOnce({ sessionId: "sess_abc", prompt: "continue" });

		expect(result.stdout).toBe("session continuation");
		// The session id appears in the POST URL
		expect(calls[0]?.url).toContain("/sessions/sess_abc/messages");
	});

	// -------------------------------------------------------------------------
	// 6. cost parsed when body has cost_usd; omitted when absent
	// -------------------------------------------------------------------------

	it("costUsd is undefined when body has no cost_usd field", async () => {
		const { fn } = fakeFetch({
			id: "msg_no_cost",
			content: [{ type: "text", text: "ok" }],
			usage: { input_tokens: 5, output_tokens: 7 },
			// cost_usd intentionally absent
		});
		const driver = makeCmaDriver({ fetch: fn, model: "claude-opus-4-5", apiKey: "sk-x" });
		const result = await driver.runOnce({ prompt: "ping" });

		expect(result.costUsd).toBeUndefined();
		// Tokens still parsed
		expect(result.tokensIn).toBe(5);
		expect(result.tokensOut).toBe(7);
	});
});
