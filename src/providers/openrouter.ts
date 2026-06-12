/**
 * OpenRouter ProviderDriver (BLUEPRINT §3.9, §3.12.13 – C4 API drivers).
 *
 * WHY this driver exists: OpenRouter is an OpenAI-compatible chat-completions
 * HTTP API that routes to many underlying models. It reports token usage in
 * every response, so cost_reporting is provable via the conformance harness.
 * Unlike the CLI drivers, there is no session/resume concept exposed here, so
 * resume is false. structured_output is delivered via the same XML-envelope
 * contract (extractStructured) as the CLI drivers — the model is instructed to
 * wrap JSON in <output>…</output>, then the conformance probe verifies it.
 *
 * Security: OPENROUTER_API_KEY is read from process.env at call time, NEVER
 * forwarded to any agent env or serialised. fetch is injected so all tests run
 * hermetically with canned responses — no live network in tests.
 *
 * Cost formula: with `usage: {include: true}` in the request body OpenRouter
 * returns a usage-accounting block carrying usage.prompt_tokens,
 * usage.completion_tokens and usage.cost (USD). We parse `usage.cost` when
 * present, otherwise leave costUsd undefined so cost_reporting is not proven
 * for that call.
 */

import type { ProviderDriver } from "./types.ts";

// ---------------------------------------------------------------------------
// Wire types for the OpenAI-compatible chat-completions response
// ---------------------------------------------------------------------------

interface ChatUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	/**
	 * OpenRouter usage-accounting cost in USD for this call. Only present when the
	 * request body carries `usage: {include: true}` (PHASE5C-CONTRACT §6.2).
	 */
	cost?: number;
}

interface ChatChoice {
	message?: { content?: string | null };
	text?: string; // legacy completions path — not used but typed defensively
}

interface ChatResponse {
	id?: string;
	choices?: ChatChoice[];
	usage?: ChatUsage;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface OpenRouterOptions {
	/**
	 * Base URL of the OpenAI-compatible endpoint.
	 * Default: "https://openrouter.ai/api/v1"
	 */
	baseUrl?: string;
	/**
	 * Model identifier forwarded in the request body. No silent default: when
	 * omitted here it is read from `env.OPENROUTER_MODEL`, and a still-missing
	 * model makes runOnce THROW (fail-closed; PHASE5C-CONTRACT §6.2).
	 */
	model?: string;
	/**
	 * Inject a custom fetch implementation for hermetic testing.
	 * Falls back to the global fetch when omitted.
	 */
	fetchFn?: typeof fetch;
	/**
	 * Inject the environment for hermetic testing (ApiDriverDeps shape).
	 * Falls back to process.env when omitted.
	 */
	env?: Record<string, string | undefined>;
}

/**
 * Build an OpenRouter ProviderDriver. Injectable fetch makes this testable
 * without any network.
 */
export function makeOpenRouterDriver(opts: OpenRouterOptions = {}): ProviderDriver {
	const baseUrl = (opts.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
	const env = opts.env ?? process.env;
	// No silent default model: deps.model ?? env.OPENROUTER_MODEL; a missing model
	// is refused at runOnce (§6.2).
	const model = opts.model ?? env["OPENROUTER_MODEL"];
	const fetchFn = opts.fetchFn ?? fetch;

	async function callChatCompletions(messages: Array<{ role: string; content: string }>): Promise<{
		content: string;
		usage: ChatUsage | undefined;
		id: string | undefined;
	}> {
		// Fail-closed: refuse to run against a fabricated default model.
		if (!model) {
			throw new Error(
				"openrouter: model not configured (set providers.openrouterModel / OPENROUTER_MODEL)",
			);
		}

		// Key is read host-side at call time — never forwarded to any agent env.
		const apiKey = env["OPENROUTER_API_KEY"];
		if (!apiKey) {
			throw new Error("openrouter: OPENROUTER_API_KEY is not set in process.env");
		}

		const res = await fetchFn(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${apiKey}`,
				// OpenRouter routing header — identifies the calling application.
				"HTTP-Referer": "https://github.com/nightshift",
				"X-Title": "nightshift",
			},
			// usage.include requests the usage-accounting block (token counts + cost);
			// without it OpenRouter omits usage and cost_reporting is unprovable (§6.2).
			body: JSON.stringify({ model, messages, usage: { include: true } }),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`openrouter: HTTP ${res.status} — ${text.slice(0, 200)}`);
		}

		const data = (await res.json()) as ChatResponse;
		const content = data.choices?.[0]?.message?.content ?? "";
		return { content, usage: data.usage, id: data.id };
	}

	return {
		name: "openrouter",
		kind: "api",

		declared: {
			interactive: false, // HTTP API — no persistent PTY session.
			resume: false,      // No session-continuation concept in chat-completions.
			fork: false,
			// XML-envelope extraction via schemaRepair.ts — UNTRUSTED until proven.
			structured_output: true,
			// usage.prompt_tokens + completion_tokens present in every response.
			cost_reporting: true,
			auth: ["api_key"],
			roles: ["reviewer", "planner", "judge", "utility", "experiment"],
		},

		async isAvailable(): Promise<boolean> {
			// Available if the API key is set; we don't make a live probe here
			// because isAvailable must not perform network I/O (tests may omit key).
			const key = env["OPENROUTER_API_KEY"];
			return typeof key === "string" && key.length > 0;
		},

		async runOnce({ prompt }) {
			const { content, usage, id } = await callChatCompletions([
				{ role: "user", content: prompt },
			]);

			const tokensIn =
				typeof usage?.prompt_tokens === "number" && usage.prompt_tokens > 0
					? usage.prompt_tokens
					: undefined;
			const tokensOut =
				typeof usage?.completion_tokens === "number" && usage.completion_tokens > 0
					? usage.completion_tokens
					: undefined;
			const costUsd =
				typeof usage?.cost === "number" && usage.cost > 0
					? usage.cost
					: undefined;

			return {
				stdout: content,
				// sessionId: not supported — resume is declared false.
				sessionId: id, // carry the response id for tracing, not for resume
				tokensIn,
				tokensOut,
				costUsd,
			};
		},

		async resumeOnce(_input) {
			// declared.resume === false; conformance harness will never call this.
			throw new Error(
				"openrouter: resume is not supported — this driver does not declare resume capability",
			);
		},
	};
}

/**
 * Default singleton driver. Uses global fetch and process.env.
 * Registry / integration code may import this directly.
 */
export const openrouter: ProviderDriver = makeOpenRouterDriver();
