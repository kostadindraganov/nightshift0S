/**
 * Hermetic conformance tests for the OpenRouter and Local ProviderDrivers
 * (C4 API drivers, BLUEPRINT §3.9 + §3.12.13).
 *
 * WHY hermetic: no live network, no OPENROUTER_API_KEY, no running ollama.
 * All HTTP is intercepted by an injected fetchFn returning canned responses.
 * Five focused cases per the house rules:
 *
 *   (1) openrouter — correct request shape (method, URL, auth header, body).
 *   (2) openrouter — response→stdout mapping + usage→cost fields extracted.
 *   (3) openrouter — missing key throws (FAIL-CLOSED; key never in agent env).
 *   (4) local      — no Authorization header emitted (no key for local inference).
 *   (5) local      — response→stdout mapping; costUsd absent (cost_reporting false).
 *
 * conformance probes for structured_output are exercised via the existing
 * conformance.test.ts (fake driver covering the harness). These tests focus
 * on the HTTP contract and field mapping that only these drivers can exercise.
 */

import { describe, expect, test } from "bun:test";
import { makeOpenRouterDriver } from "./openrouter.ts";
import { makeLocalDriver } from "./local.ts";

// ---------------------------------------------------------------------------
// Helpers — canned fetch builders
// ---------------------------------------------------------------------------

/** Build a fetchFn that asserts on the request then returns a canned response. */
function makeFetch(
	assertFn: (url: string, init: RequestInit) => void,
	body: object,
	status = 200,
): typeof fetch {
	// Test mock: the drivers only ever call fetch(url, init); `preconnect` (a
	// static on Bun's `typeof fetch`) is never exercised, so we cast structurally.
	const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
		assertFn(url, init ?? {});
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	};
	return fn as unknown as typeof fetch;
}

/** Canned chat-completions response with token usage and cost. */
const CANNED_OPENROUTER_RESPONSE = {
	id: "chatcmpl-abc",
	choices: [{ message: { content: "<output>{\"ok\":true}</output>" } }],
	usage: { prompt_tokens: 12, completion_tokens: 8, cost: 0.00042 },
};

/** Canned chat-completions response without cost (as local models look). */
const CANNED_LOCAL_RESPONSE = {
	id: "local-resp-1",
	choices: [{ message: { content: "Hello from local model" } }],
	usage: { prompt_tokens: 7, completion_tokens: 5 },
};

// ---------------------------------------------------------------------------
// (1) openrouter — request shape: method, URL, auth header, body
// ---------------------------------------------------------------------------

describe("openrouter: request shape", () => {
	test("sends POST with correct URL, Authorization header, and body", async () => {
		let capturedUrl = "";
		let capturedHeaders: Record<string, string> = {};
		let capturedBody: unknown = null;

		const fetchFn = makeFetch((url, init) => {
			capturedUrl = url;
			capturedHeaders = Object.fromEntries(
				Object.entries((init.headers as Record<string, string>) ?? {}),
			);
			capturedBody = JSON.parse(init.body as string);
		}, CANNED_OPENROUTER_RESPONSE);

		const driver = makeOpenRouterDriver({
			baseUrl: "https://openrouter.ai/api/v1",
			model: "openai/gpt-4o-mini",
			fetchFn,
		});

		// Inject a fake key so the driver doesn't throw on missing key.
		const origKey = process.env["OPENROUTER_API_KEY"];
		process.env["OPENROUTER_API_KEY"] = "sk-or-test-key";
		try {
			await driver.runOnce({ prompt: "Say hello" });
		} finally {
			if (origKey === undefined) delete process.env["OPENROUTER_API_KEY"];
			else process.env["OPENROUTER_API_KEY"] = origKey;
		}

		expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(capturedHeaders["Authorization"]).toBe("Bearer sk-or-test-key");
		expect((capturedBody as { model: string }).model).toBe("openai/gpt-4o-mini");
		expect(
			(capturedBody as { messages: Array<{ role: string; content: string }> }).messages[0]?.role,
		).toBe("user");
	});
});

// ---------------------------------------------------------------------------
// (2) openrouter — response→stdout + usage→cost field mapping
// ---------------------------------------------------------------------------

describe("openrouter: response→stdout and usage→cost mapping", () => {
	test("stdout, tokensIn, tokensOut, costUsd extracted from canned response", async () => {
		const fetchFn = makeFetch(() => {}, CANNED_OPENROUTER_RESPONSE);
		const driver = makeOpenRouterDriver({
			baseUrl: "https://openrouter.ai/api/v1",
			model: "openai/gpt-4o-mini",
			fetchFn,
		});

		const origKey = process.env["OPENROUTER_API_KEY"];
		process.env["OPENROUTER_API_KEY"] = "sk-or-test-key";
		let result: Awaited<ReturnType<typeof driver.runOnce>>;
		try {
			result = await driver.runOnce({ prompt: "emit JSON" });
		} finally {
			if (origKey === undefined) delete process.env["OPENROUTER_API_KEY"];
			else process.env["OPENROUTER_API_KEY"] = origKey;
		}

		expect(result.stdout).toBe("<output>{\"ok\":true}</output>");
		expect(result.tokensIn).toBe(12);
		expect(result.tokensOut).toBe(8);
		expect(result.costUsd).toBeCloseTo(0.00042);
		// sessionId carries the response id for tracing.
		expect(result.sessionId).toBe("chatcmpl-abc");
	});
});

// ---------------------------------------------------------------------------
// (3) openrouter — FAIL-CLOSED: missing key throws; key never forwarded
// ---------------------------------------------------------------------------

describe("openrouter: missing key is fail-closed", () => {
	test("runOnce throws when OPENROUTER_API_KEY is not set", async () => {
		const fetchFn = makeFetch(() => {}, CANNED_OPENROUTER_RESPONSE);
		// Model configured so the missing-KEY check is the one that fires.
		const driver = makeOpenRouterDriver({ model: "openai/gpt-4o-mini", fetchFn });

		// Temporarily unset the key.
		const origKey = process.env["OPENROUTER_API_KEY"];
		delete process.env["OPENROUTER_API_KEY"];

		try {
			await expect(driver.runOnce({ prompt: "hello" })).rejects.toThrow(
				"OPENROUTER_API_KEY is not set",
			);
		} finally {
			if (origKey !== undefined) process.env["OPENROUTER_API_KEY"] = origKey;
		}
	});
});

// ---------------------------------------------------------------------------
// (4) local — no Authorization header emitted (no key for local inference)
// ---------------------------------------------------------------------------

describe("local: no Authorization header emitted", () => {
	test("request to local endpoint carries no Authorization header", async () => {
		let capturedHeaders: Record<string, string> = {};

		const fetchFn = makeFetch((_url, init) => {
			capturedHeaders = Object.fromEntries(
				Object.entries((init.headers as Record<string, string>) ?? {}),
			);
		}, CANNED_LOCAL_RESPONSE);

		const driver = makeLocalDriver({
			baseUrl: "http://localhost:11434/v1",
			model: "llama3",
			fetchFn,
		});

		await driver.runOnce({ prompt: "Say hello" });

		expect(capturedHeaders["Authorization"]).toBeUndefined();
		expect(capturedHeaders["Content-Type"]).toBe("application/json");
	});
});

// ---------------------------------------------------------------------------
// (5) local — response→stdout mapping; costUsd absent (cost_reporting false)
// ---------------------------------------------------------------------------

describe("local: response→stdout and no costUsd", () => {
	test("stdout extracted; costUsd is undefined; token counts present", async () => {
		const fetchFn = makeFetch(() => {}, CANNED_LOCAL_RESPONSE);
		const driver = makeLocalDriver({
			baseUrl: "http://localhost:11434/v1",
			model: "llama3",
			fetchFn,
		});

		const result = await driver.runOnce({ prompt: "say hello" });

		expect(result.stdout).toBe("Hello from local model");
		// cost_reporting is false — costUsd must not be present.
		expect(result.costUsd).toBeUndefined();
		// Token counts are opportunistic — present when server emits them.
		expect(result.tokensIn).toBe(7);
		expect(result.tokensOut).toBe(5);
	});

	test("local driver declared cost_reporting is false", () => {
		const driver = makeLocalDriver({
			fetchFn: (async () => new Response("{}")) as unknown as typeof fetch,
		});
		expect(driver.declared.cost_reporting).toBe(false);
	});

	test("openrouter driver declared cost_reporting is true", () => {
		const driver = makeOpenRouterDriver({
			fetchFn: (async () => new Response("{}")) as unknown as typeof fetch,
		});
		expect(driver.declared.cost_reporting).toBe(true);
	});

	// FAIL-CLOSED (§6.2): no env model and no opts.model ⇒ runOnce must refuse
	// rather than billing against a fabricated default. Injected empty env keeps
	// it hermetic regardless of the host's process.env.
	test("local runOnce rejects when no model is configured", async () => {
		const driver = makeLocalDriver({
			baseUrl: "http://127.0.0.1:11434/v1",
			env: {},
			fetchFn: (async () => new Response("{}")) as unknown as typeof fetch,
		});
		await expect(driver.runOnce({ prompt: "hi" })).rejects.toThrow("model not configured");
	});
});
