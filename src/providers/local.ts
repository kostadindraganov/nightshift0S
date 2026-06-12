/**
 * Local ProviderDriver — ollama / llama.cpp (BLUEPRINT §3.9, §3.12.13 – C4 API drivers).
 *
 * WHY this driver exists: local models running via ollama or llama.cpp expose
 * the same OpenAI-compatible chat-completions endpoint at a configurable base
 * URL (default: http://localhost:11434/v1 for ollama). No API key is required.
 * This covers the "local" AuthLane and keeps the conformance harness in the
 * same place as the remote drivers.
 *
 * Key differences from openrouter:
 *   - No API key — local inference, no secret needed.
 *   - baseUrl is configurable at construction time (env var
 *     NIGHTSHIFT_LOCAL_BASE_URL or explicit option; default 127.0.0.1:11434).
 *   - cost_reporting: false — local models do not report USD cost. Token counts
 *     may or may not be present depending on the server; we read them
 *     opportunistically but do NOT declare cost_reporting true.
 *   - auth lane: "local" (not "api_key").
 *
 * structured_output is via the same XML-envelope / extractStructured contract
 * as all other drivers — UNTRUSTED until the conformance probe succeeds.
 *
 * fetch is injected so tests are hermetic — no live network in tests.
 */

import type { ProviderDriver } from "./types.ts";

// ---------------------------------------------------------------------------
// Wire types (shared shape with openrouter — kept local to avoid coupling)
// ---------------------------------------------------------------------------

interface ChatUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
}

interface ChatChoice {
	message?: { content?: string | null };
}

interface ChatResponse {
	id?: string;
	choices?: ChatChoice[];
	usage?: ChatUsage;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface LocalDriverOptions {
	/**
	 * Base URL of the local OpenAI-compatible endpoint.
	 * Default: env.NIGHTSHIFT_LOCAL_BASE_URL ?? "http://127.0.0.1:11434/v1"
	 */
	baseUrl?: string;
	/**
	 * Model identifier forwarded in the request body. No silent default: when
	 * omitted here it is read from `env.NIGHTSHIFT_LOCAL_MODEL`, and a still-missing
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
 * Build a local-inference ProviderDriver. Injectable fetch and baseUrl make
 * this testable without any network or running ollama instance.
 */
export function makeLocalDriver(opts: LocalDriverOptions = {}): ProviderDriver {
	const env = opts.env ?? process.env;
	const baseUrl = (
		opts.baseUrl ??
		env["NIGHTSHIFT_LOCAL_BASE_URL"] ??
		"http://127.0.0.1:11434/v1"
	).replace(/\/$/, "");

	// No silent default model: deps.model ?? env.NIGHTSHIFT_LOCAL_MODEL; a missing
	// model is refused at runOnce (§6.2).
	const model = opts.model ?? env["NIGHTSHIFT_LOCAL_MODEL"];
	const fetchFn = opts.fetchFn ?? fetch;

	async function callChatCompletions(messages: Array<{ role: string; content: string }>): Promise<{
		content: string;
		usage: ChatUsage | undefined;
		id: string | undefined;
	}> {
		// Fail-closed: refuse to run against a fabricated default model.
		if (!model) {
			throw new Error(
				"local: model not configured (set providers.localModel / NIGHTSHIFT_LOCAL_MODEL)",
			);
		}

		// No API key — local inference; omit Authorization header entirely.
		const res = await fetchFn(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model, messages }),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`local: HTTP ${res.status} — ${text.slice(0, 200)}`);
		}

		const data = (await res.json()) as ChatResponse;
		const content = data.choices?.[0]?.message?.content ?? "";
		return { content, usage: data.usage, id: data.id };
	}

	return {
		name: "local",
		kind: "api",

		declared: {
			interactive: false, // HTTP request/response — no persistent session.
			resume: false,      // No session-continuation in chat-completions.
			fork: false,
			// XML-envelope extraction — UNTRUSTED until conformance proven.
			structured_output: true,
			// Local models do NOT report USD cost.
			cost_reporting: false,
			auth: ["local"],
			roles: ["reviewer", "planner", "judge", "utility", "experiment"],
		},

		async isAvailable(): Promise<boolean> {
			// Attempt a lightweight OPTIONS/HEAD; fall back to a minimal POST if the
			// server doesn't support HEAD. We wrap in try/catch — network errors mean
			// unavailable, not a crash.
			try {
				const res = await fetchFn(`${baseUrl}/models`, {
					method: "GET",
					headers: { "Content-Type": "application/json" },
					signal: AbortSignal.timeout(2000),
				});
				return res.ok || res.status === 404; // 404 means server is up but path differs
			} catch {
				return false;
			}
		},

		async runOnce({ prompt }) {
			const { content, usage, id } = await callChatCompletions([
				{ role: "user", content: prompt },
			]);

			// Token counts are opportunistic — some local servers omit them.
			const tokensIn =
				typeof usage?.prompt_tokens === "number" && usage.prompt_tokens > 0
					? usage.prompt_tokens
					: undefined;
			const tokensOut =
				typeof usage?.completion_tokens === "number" && usage.completion_tokens > 0
					? usage.completion_tokens
					: undefined;

			return {
				stdout: content,
				// sessionId carried for tracing only, not for resume.
				sessionId: id,
				tokensIn,
				tokensOut,
				// costUsd omitted — local inference has no USD cost.
			};
		},

		async resumeOnce(_input) {
			// declared.resume === false; conformance harness will never call this.
			throw new Error(
				"local: resume is not supported — this driver does not declare resume capability",
			);
		},
	};
}

/**
 * Default singleton driver. Uses global fetch and env-configured base URL.
 * Registry / integration code may import this directly.
 */
export const local: ProviderDriver = makeLocalDriver();
