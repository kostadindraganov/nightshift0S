/**
 * CMA ProviderDriver — Anthropic Managed Agents (BLUEPRINT §3.12.13 – C4 API drivers).
 *
 * WHY this driver exists: Anthropic's Managed Agents API (CMA) offers server-managed
 * sessions, letting a caller continue a conversation by session id. It is an HTTP API
 * driver (kind: "api") — there is no local CLI binary and no PTY, so interactive is
 * false. Sessions are resumed via a distinct endpoint, so resume is declared true;
 * however, because the real CMA API is GATE-5 (not yet accessible in tests), runOnce
 * returns a sessionId only when the response body carries one — if it doesn't, the
 * conformance resume probe will fail-closed (exactly the same honest stance as
 * gemini.ts).
 *
 * Security: CMA_API_KEY is read from process.env at call time, NEVER forwarded to any
 * agent env, NEVER logged, NEVER included in error messages. fetch is injectable so
 * all tests run hermetically with canned responses — no live network in tests.
 *
 * Cost: the Anthropic Messages API response body carries usage.input_tokens,
 * usage.output_tokens, and (when billing is enabled) a top-level cost_usd field.
 * We parse costUsd only when that field is a positive number; otherwise we leave it
 * undefined so cost_reporting is not proven for that call.
 *
 * Structured output: XML-envelope extraction via extractStructured (same UNTRUSTED
 * contract as openrouter / claude-code). The conformance structured_output probe
 * proves it or fails-closed.
 */

import type { ProviderDriver } from "./types.ts";

// ---------------------------------------------------------------------------
// FetchFn type — injectable for hermetic tests
// ---------------------------------------------------------------------------

/** Minimal injectable fetch signature — matches the global `fetch` surface we use. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Wire types for the Anthropic Messages API response
// ---------------------------------------------------------------------------

interface ContentBlock {
	type: string;
	text?: string;
}

interface CmaUsage {
	input_tokens?: number;
	output_tokens?: number;
}

interface CmaResponse {
	/** Anthropic session / message id — doubles as sessionId for resume. */
	id?: string;
	/** Managed-session continuation id (may differ from message id in CMA). */
	session_id?: string;
	content?: ContentBlock[];
	usage?: CmaUsage;
	/** Top-level USD cost field present when Anthropic billing is active. */
	cost_usd?: number;
}

// ---------------------------------------------------------------------------
// Factory deps
// ---------------------------------------------------------------------------

export interface CmaDeps {
	fetch: FetchFn;
	model: string;
	/** Anthropic API key — if absent, isAvailable() returns false and runOnce throws. */
	apiKey?: string;
	/**
	 * Base URL for the CMA API.
	 * Default: "https://api.anthropic.com/v1" (the standard Anthropic Messages endpoint).
	 * Override via CMA_BASE_URL for staging or a future managed-agents endpoint.
	 */
	baseUrl?: string;
}

// ---------------------------------------------------------------------------
// makeCmaDriver
// ---------------------------------------------------------------------------

/**
 * Build a CMA ProviderDriver. Injectable fetch makes this testable without any
 * network. Mirror of makeOpenRouterDriver — same fail-closed stances.
 */
export function makeCmaDriver(deps: CmaDeps): ProviderDriver {
	const baseUrl = (deps.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
	const model = deps.model;
	// apiKey is intentionally NOT destructured into a local const here — it is read
	// at call time from deps.apiKey so the test can pass undefined and verify the
	// throw without any risk of the key leaking into a closure-captured string.

	/** Shared POST helper — enforces fail-closed checks and key hygiene. */
	async function post(path: string, body: Record<string, unknown>): Promise<CmaResponse> {
		// Fail-closed: refuse to run without a model (mirrors openrouter §6.2).
		if (!model) {
			throw new Error(
				"cma: model not configured (set CMA_MODEL env var)",
			);
		}

		const apiKey = deps.apiKey;
		if (!apiKey) {
			throw new Error("cma: CMA_API_KEY is not set");
			// Key NEVER logged — error message contains no secret value.
		}

		const res = await deps.fetch(`${baseUrl}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				// Anthropic header convention: x-api-key (not Bearer).
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"anthropic-beta": "managed-agents-2025-01-01",
			},
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			// Key is NOT included — only status + truncated body.
			throw new Error(`cma: HTTP ${res.status} — ${text.slice(0, 200)}`);
		}

		return (await res.json()) as CmaResponse;
	}

	/** Extract the text content from the response content array. */
	function extractText(data: CmaResponse): string {
		if (!data.content) return "";
		return data.content
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("");
	}

	/** Parse usage + cost from the response body. Only set fields we actually read. */
	function parseTelemetry(data: CmaResponse): {
		tokensIn?: number;
		tokensOut?: number;
		costUsd?: number;
	} {
		const tokensIn =
			typeof data.usage?.input_tokens === "number" && data.usage.input_tokens > 0
				? data.usage.input_tokens
				: undefined;
		const tokensOut =
			typeof data.usage?.output_tokens === "number" && data.usage.output_tokens > 0
				? data.usage.output_tokens
				: undefined;
		// cost_usd is a top-level field in CMA billing responses — omit when absent.
		const costUsd =
			typeof data.cost_usd === "number" && data.cost_usd > 0
				? data.cost_usd
				: undefined;
		return { tokensIn, tokensOut, costUsd };
	}

	return {
		name: "cma",
		kind: "api",

		declared: {
			// HTTP API — no persistent PTY session.
			interactive: false,
			// CMA exposes managed sessions with continuation ids. BUT: runOnce returns a
			// sessionId only when the response body carries session_id or id. If the real
			// endpoint (GATE-5) does not surface one, the conformance resume probe
			// fail-closes — exactly the honest stance gemini.ts takes for its -r flag.
			resume: true,
			fork: false,
			// XML-envelope extraction via extractStructured — UNTRUSTED until the
			// conformance structured_output probe succeeds.
			structured_output: true,
			// cost_usd field is parsed when present; the probe will confirm at runtime.
			cost_reporting: true,
			auth: ["api_key"],
			roles: ["coder", "reviewer", "planner", "utility", "experiment"],
		},

		async isAvailable(): Promise<boolean> {
			// Available iff both model and api key are set — mirrors openrouter's logic.
			// No live network probe: isAvailable must not perform I/O (tests omit key).
			return (
				typeof model === "string" &&
				model.length > 0 &&
				typeof deps.apiKey === "string" &&
				deps.apiKey.length > 0
			);
		},

		async runOnce({ prompt, cwd: _cwd }) {
			const data = await post("/messages", {
				model,
				max_tokens: 8192,
				messages: [{ role: "user", content: prompt }],
			});

			const stdout = extractText(data);
			// Prefer the managed-session continuation id; fall back to message id.
			// If neither is present the resume conformance probe will fail-closed.
			const sessionId = data.session_id ?? data.id;
			const { tokensIn, tokensOut, costUsd } = parseTelemetry(data);

			return { stdout, sessionId, tokensIn, tokensOut, costUsd };
		},

		async resumeOnce({ sessionId, prompt }) {
			// Continue a managed session by posting to the session-scoped messages endpoint.
			const data = await post(`/sessions/${sessionId}/messages`, {
				model,
				max_tokens: 8192,
				messages: [{ role: "user", content: prompt }],
			});
			return { stdout: extractText(data) };
		},
	};
}

// ---------------------------------------------------------------------------
// Production wiring — mirrors openrouter's production const exactly.
// ---------------------------------------------------------------------------
//
// Env vars consumed:
//   CMA_MODEL    — required; the Anthropic model id (e.g. "claude-opus-4-5")
//   CMA_API_KEY  — required; the Anthropic API key
//   CMA_BASE_URL — optional; override the API base URL (default: https://api.anthropic.com/v1)

export const cma: ProviderDriver = makeCmaDriver({
	fetch,
	model: process.env["CMA_MODEL"] ?? "",
	apiKey: process.env["CMA_API_KEY"],
	baseUrl: process.env["CMA_BASE_URL"],
});
