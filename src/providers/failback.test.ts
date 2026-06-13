/**
 * Failback policy tests (UNIT 5.6b — pure policy module, no DB/events).
 *
 * All tests are hermetic: no side effects, no database, no event log. The module
 * is a pure classification + routing decision engine. Tests cover:
 *
 *   1. classifyFailure: mapping exit_reason strings (or null) to FailureClass.
 *   2. failbackDecision: within-task action (retry_same / failback_model / stop).
 *   3. routingDecision: between-task reassign avoidance (collect failed providers).
 *
 * Matrix (≤5 cases per function):
 *   classifyFailure: null → unknown; context overflow; rate limit; auth;
 *     retryable (transient/network/5xx).
 *   failbackDecision: stop on policy; retry_same while attempts < max; failback
 *     to next model in chain; stop when chain exhausted/provider unknown.
 *   routingDecision: no failures → empty avoid; failed runs → unique providers.
 */

import { describe, expect, test } from "bun:test";
import {
	classifyFailure,
	failbackDecision,
	routingDecision,
	ALLOWED_TRANSITIONS,
	MODEL_FAMILIES,
	type FailureClass,
} from "./failback.ts";

// ---------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------

describe("classifyFailure", () => {
	test("null exit_reason → unknown", () => {
		expect(classifyFailure(null)).toBe("unknown");
	});

	test("context overflow keywords (priority 1) → context_overflow", () => {
		expect(classifyFailure("context length exceeded")).toBe("context_overflow");
		expect(classifyFailure("context_length too large")).toBe("context_overflow");
		expect(classifyFailure("token window exhausted")).toBe("context_overflow");
		expect(classifyFailure("MAXIMUM CONTEXT reached")).toBe("context_overflow");
		expect(classifyFailure("prompt is too long")).toBe("context_overflow");
		expect(classifyFailure("too many tokens in request")).toBe("context_overflow");
	});

	test("rate limit keywords (priority 2) → rate_limit", () => {
		expect(classifyFailure("429 too many requests")).toBe("rate_limit");
		expect(classifyFailure("rate_limit exceeded")).toBe("rate_limit");
		expect(classifyFailure("Rate limit: retry after 60s")).toBe("rate_limit");
		expect(classifyFailure("too many requests to the API")).toBe("rate_limit");
	});

	test("auth/quota keywords (priority 3) → auth", () => {
		expect(classifyFailure("401 unauthorized")).toBe("auth");
		expect(classifyFailure("403 forbidden")).toBe("auth");
		expect(classifyFailure("auth_limit reached")).toBe("auth");
		expect(classifyFailure("invalid_api_key")).toBe("auth");
		expect(classifyFailure("quota exhausted")).toBe("auth");
		expect(classifyFailure("usage_limit exceeded")).toBe("auth");
		expect(classifyFailure("authentication_error: bad token")).toBe("auth");
	});

	test("transient/network/5xx keywords (priority 4) → retryable", () => {
		expect(classifyFailure("transient network error")).toBe("retryable");
		expect(classifyFailure("NETWORK unavailable")).toBe("retryable");
		expect(classifyFailure("connection refused")).toBe("retryable");
		expect(classifyFailure("timeout after 30s")).toBe("retryable");
		expect(classifyFailure("timed out waiting for response")).toBe("retryable");
		expect(classifyFailure("ECONNRESET")).toBe("retryable");
		expect(classifyFailure("ECONNREFUSED")).toBe("retryable");
		expect(classifyFailure("ENOTFOUND")).toBe("retryable");
		expect(classifyFailure("socket hang up")).toBe("retryable");
		expect(classifyFailure("HTTP 500 Internal Server Error")).toBe("retryable");
		expect(classifyFailure("502 bad gateway")).toBe("retryable");
		expect(classifyFailure("503 service unavailable")).toBe("retryable");
		expect(classifyFailure("504 gateway timeout")).toBe("retryable");
		expect(classifyFailure("internal error")).toBe("retryable");
		expect(classifyFailure("server error: overloaded")).toBe("retryable");
	});

	test("unknown keywords → unknown (fail-closed)", () => {
		expect(classifyFailure("segmentation fault")).toBe("unknown");
		expect(classifyFailure("memory allocation failed")).toBe("unknown");
		expect(classifyFailure("disk full")).toBe("unknown");
		expect(classifyFailure("")).toBe("unknown");
	});

	test("case-insensitive matching", () => {
		expect(classifyFailure("CONTEXT OVERFLOW")).toBe("context_overflow");
		expect(classifyFailure("Rate_LIMIT")).toBe("rate_limit");
		expect(classifyFailure("Unauthorized")).toBe("auth");
		expect(classifyFailure("TIMEOUT")).toBe("retryable");
	});

	test("context overflow checked before auth (token in both)", () => {
		// Some providers embed "token" in both context-window and auth errors.
		// Spec says context check first to avoid misclassification.
		expect(classifyFailure("maximum context length exceeded")).toBe("context_overflow");
		expect(classifyFailure("too many tokens in request")).toBe("context_overflow");
	});
});

// ---------------------------------------------------------------------------
// failbackDecision
// ---------------------------------------------------------------------------

describe("failbackDecision", () => {
	test("stop policies (rate_limit, auth, context_overflow, unknown)", () => {
		const classesToStop: FailureClass[] = [
			"rate_limit",
			"auth",
			"context_overflow",
			"unknown",
		];

		for (const cls of classesToStop) {
			const decision = failbackDecision({
				provider: "claude-code",
				model: "claude-opus-4-8",
				failureClass: cls,
				attempt: 1,
				maxAttempts: 3,
			});
			expect(decision.action).toBe("stop");
			expect(decision.nextModel).toBeUndefined();
			expect(decision.reason).toContain(`failureClass=${cls}`);
		}
	});

	test("retryable: retry_same while attempts < maxAttempts", () => {
		const decision = failbackDecision({
			provider: "claude-code",
			model: "claude-opus-4-8",
			failureClass: "retryable",
			attempt: 1,
			maxAttempts: 3,
		});
		expect(decision.action).toBe("retry_same");
		expect(decision.reason).toContain("attempt=1/3");
		expect(decision.nextModel).toBeUndefined();
	});

	test("retryable: attempt=2/3 still retry_same", () => {
		const decision = failbackDecision({
			provider: "claude-code",
			model: "claude-opus-4-8",
			failureClass: "retryable",
			attempt: 2,
			maxAttempts: 3,
		});
		expect(decision.action).toBe("retry_same");
		expect(decision.reason).toContain("attempt=2/3");
	});

	test("retryable: exhausted attempts → failback_model to next in chain", () => {
		const decision = failbackDecision({
			provider: "claude-code",
			model: "claude-opus-4-8",
			failureClass: "retryable",
			attempt: 3,
			maxAttempts: 3,
		});
		expect(decision.action).toBe("failback_model");
		expect(decision.nextModel).toBe("claude-opus-4-7");
		expect(decision.reason).toContain("claude-opus-4-8");
		expect(decision.reason).toContain("claude-opus-4-7");
	});

	test("retryable: failback from middle of chain", () => {
		const decision = failbackDecision({
			provider: "claude-code",
			model: "claude-opus-4-7",
			failureClass: "retryable",
			attempt: 5,
			maxAttempts: 5,
		});
		expect(decision.action).toBe("failback_model");
		expect(decision.nextModel).toBe("claude-sonnet-4-6");
	});

	test("retryable: last model in chain → stop (chain exhausted)", () => {
		const decision = failbackDecision({
			provider: "claude-code",
			model: "claude-sonnet-4-6",
			failureClass: "retryable",
			attempt: 10,
			maxAttempts: 10,
		});
		expect(decision.action).toBe("stop");
		expect(decision.nextModel).toBeUndefined();
		expect(decision.reason).toContain("chain exhausted");
	});

	test("unknown provider → stop (not in MODEL_FAMILIES)", () => {
		const decision = failbackDecision({
			provider: "unknown-provider",
			model: "some-model",
			failureClass: "retryable",
			attempt: 5,
			maxAttempts: 5,
		});
		expect(decision.action).toBe("stop");
		expect(decision.reason).toContain("not in MODEL_FAMILIES");
	});

	test("model not in chain for provider → stop", () => {
		const decision = failbackDecision({
			provider: "claude-code",
			model: "gpt-4", // not in claude-code chain
			failureClass: "retryable",
			attempt: 5,
			maxAttempts: 5,
		});
		expect(decision.action).toBe("stop");
		expect(decision.reason).toContain("not found in chain");
	});

	test("multiple providers never cross vendor (codex chain)", () => {
		// codex chain: [o3, o4-mini, gpt-4o]
		const decision = failbackDecision({
			provider: "codex",
			model: "o3",
			failureClass: "retryable",
			attempt: 5,
			maxAttempts: 5,
		});
		expect(decision.action).toBe("failback_model");
		expect(decision.nextModel).toBe("o4-mini");
		expect(decision.reason).toContain("codex"); // stays within codex
	});

	test("ALLOWED_TRANSITIONS table is authoritative", () => {
		// Verify the table itself matches the documented policy.
		expect(ALLOWED_TRANSITIONS.retryable).toBe("retry_same");
		expect(ALLOWED_TRANSITIONS.rate_limit).toBe("stop");
		expect(ALLOWED_TRANSITIONS.auth).toBe("stop");
		expect(ALLOWED_TRANSITIONS.context_overflow).toBe("stop");
		expect(ALLOWED_TRANSITIONS.unknown).toBe("stop");
	});

	test("attempt count edge cases: 0 and negative (treated as < maxAttempts)", () => {
		// Attempt 0 is nonsensical but should be treated as retry_same (0 < 3).
		const decision0 = failbackDecision({
			provider: "claude-code",
			model: "claude-opus-4-8",
			failureClass: "retryable",
			attempt: 0,
			maxAttempts: 3,
		});
		expect(decision0.action).toBe("retry_same");

		// Negative attempt is also nonsensical but < maxAttempts.
		const decisionNeg = failbackDecision({
			provider: "claude-code",
			model: "claude-opus-4-8",
			failureClass: "retryable",
			attempt: -1,
			maxAttempts: 3,
		});
		expect(decisionNeg.action).toBe("retry_same");
	});

	test("maxAttempts=1: first attempt immediately escalates to failback (fail-closed)", () => {
		// When maxAttempts=1, attempt=1 >= maxAttempts=1: should failback, not retry.
		const decision = failbackDecision({
			provider: "claude-code",
			model: "claude-opus-4-8",
			failureClass: "retryable",
			attempt: 1,
			maxAttempts: 1,
		});
		expect(decision.action).toBe("failback_model");
		expect(decision.nextModel).toBe("claude-opus-4-7");
	});

	test("vendor isolation: claude-code model cannot reach codex/gemini models (never cross vendor)", () => {
		// Exhaust the entire claude-code chain — must stop, never jump to another vendor.
		const lastInChain = failbackDecision({
			provider: "claude-code",
			model: "claude-sonnet-4-6", // last in claude-code chain
			failureClass: "retryable",
			attempt: 3,
			maxAttempts: 3,
		});
		expect(lastInChain.action).toBe("stop");
		// nextModel must NOT be any codex or gemini model.
		expect(lastInChain.nextModel).toBeUndefined();
	});

	test("auth stop is immediate and does not consult MODEL_FAMILIES (fail-closed)", () => {
		// Even at attempt=1 with attempts remaining and a valid chain position,
		// auth MUST stop — capacity credential is dead for the whole provider.
		const decision = failbackDecision({
			provider: "claude-code",
			model: "claude-opus-4-8",
			failureClass: "auth",
			attempt: 1,
			maxAttempts: 10,
		});
		expect(decision.action).toBe("stop");
		expect(decision.nextModel).toBeUndefined();
		// Reason must reference the policy, not the chain.
		expect(decision.reason).toContain("policy=stop");
	});
});

// ---------------------------------------------------------------------------
// routingDecision
// ---------------------------------------------------------------------------

describe("routingDecision", () => {
	test("no prior runs → empty avoidProviders", () => {
		const decision = routingDecision({ priorCoderRuns: [] });
		expect(decision.avoidProviders).toEqual([]);
		expect(decision.reason).toContain("no prior failed coder runs");
	});

	test("succeeded/killed/interrupted runs → not included in avoidProviders", () => {
		const decision = routingDecision({
			priorCoderRuns: [
				{
					provider: "claude-code",
					model: "claude-opus-4-8",
					exitReason: null,
					state: "succeeded",
				},
				{
					provider: "codex",
					model: "o3",
					exitReason: null,
					state: "killed",
				},
				{
					provider: "gemini",
					model: "gemini-2-5-pro",
					exitReason: null,
					state: "interrupted",
				},
			],
		});
		expect(decision.avoidProviders).toEqual([]);
		expect(decision.reason).toContain("no prior failed coder runs");
	});

	test("single failed run → provider added to avoidProviders", () => {
		const decision = routingDecision({
			priorCoderRuns: [
				{
					provider: "claude-code",
					model: "claude-opus-4-8",
					exitReason: "context overflow",
					state: "failed",
				},
			],
		});
		expect(decision.avoidProviders).toContain("claude-code");
		expect(decision.reason).toContain("claude-code");
	});

	test("multiple failed runs from different providers → all providers collected", () => {
		const decision = routingDecision({
			priorCoderRuns: [
				{
					provider: "claude-code",
					model: "claude-opus-4-8",
					exitReason: "auth error",
					state: "failed",
				},
				{
					provider: "codex",
					model: "o3",
					exitReason: "timeout",
					state: "failed",
				},
				{
					provider: "gemini",
					model: "gemini-2-5-pro",
					exitReason: "rate limit",
					state: "failed",
				},
			],
		});
		expect(decision.avoidProviders.length).toBe(3);
		expect(decision.avoidProviders).toContain("claude-code");
		expect(decision.avoidProviders).toContain("codex");
		expect(decision.avoidProviders).toContain("gemini");
	});

	test("duplicate provider in failed runs → deduplicated in result", () => {
		const decision = routingDecision({
			priorCoderRuns: [
				{
					provider: "claude-code",
					model: "claude-opus-4-8",
					exitReason: "error 1",
					state: "failed",
				},
				{
					provider: "claude-code",
					model: "claude-opus-4-7",
					exitReason: "error 2",
					state: "failed",
				},
				{
					provider: "claude-code",
					model: "claude-sonnet-4-6",
					exitReason: "error 3",
					state: "failed",
				},
			],
		});
		expect(decision.avoidProviders).toEqual(["claude-code"]);
		expect(decision.reason).toContain("claude-code");
	});

	test("mixed states: failed + succeeded → only failed provider included", () => {
		const decision = routingDecision({
			priorCoderRuns: [
				{
					provider: "claude-code",
					model: "claude-opus-4-8",
					exitReason: null,
					state: "succeeded",
				},
				{
					provider: "codex",
					model: "o3",
					exitReason: "error",
					state: "failed",
				},
				{
					provider: "claude-code",
					model: "claude-opus-4-7",
					exitReason: "error",
					state: "failed",
				},
			],
		});
		expect(decision.avoidProviders).toContain("codex");
		expect(decision.avoidProviders).toContain("claude-code");
		expect(decision.avoidProviders.length).toBe(2);
	});

	test("exitReason is logged but does not affect provider filtering logic", () => {
		// The exitReason field is present but routingDecision only cares about state.
		const decision = routingDecision({
			priorCoderRuns: [
				{
					provider: "claude-code",
					model: "claude-opus-4-8",
					exitReason: "context overflow",
					state: "failed",
				},
				{
					provider: "claude-code",
					model: "claude-opus-4-7",
					exitReason: "auth error",
					state: "failed",
				},
			],
		});
		// Both failed, so provider is in avoidProviders regardless of exitReason.
		expect(decision.avoidProviders).toEqual(["claude-code"]);
	});

	test("MODEL_FAMILIES is used for policy boundaries but not in routingDecision", () => {
		// routingDecision is agnostic to MODEL_FAMILIES; it just collects
		// failed providers. It doesn't enforce that the provider exists in
		// MODEL_FAMILIES (that's failbackDecision's job).
		const decision = routingDecision({
			priorCoderRuns: [
				{
					provider: "unknown-vendor",
					model: "unknown-model",
					exitReason: "error",
					state: "failed",
				},
			],
		});
		expect(decision.avoidProviders).toContain("unknown-vendor");
	});

	test("cancelled/timed_out states do NOT trigger provider avoidance (fail-closed: only 'failed' state)", () => {
		// Only the explicit "failed" terminal state should block a provider.
		// Other terminal states (cancelled, timed_out) do not carry a negative
		// provider signal and must NOT populate avoidProviders.
		const decision = routingDecision({
			priorCoderRuns: [
				{
					provider: "claude-code",
					model: "claude-opus-4-8",
					exitReason: "timeout after 120s",
					state: "timed_out",
				},
				{
					provider: "codex",
					model: "o3",
					exitReason: null,
					state: "cancelled",
				},
			],
		});
		expect(decision.avoidProviders).toEqual([]);
		expect(decision.reason).toContain("no prior failed coder runs");
	});
});

// ---------------------------------------------------------------------------
// Integration: classifyFailure + failbackDecision roundtrip
// ---------------------------------------------------------------------------

describe("integration: classifyFailure → failbackDecision", () => {
	test("real 429 error flow: classify → stop", () => {
		const failureClass = classifyFailure("HTTP 429 rate limit exceeded");
		expect(failureClass).toBe("rate_limit");

		const decision = failbackDecision({
			provider: "claude-code",
			model: "claude-opus-4-8",
			failureClass,
			attempt: 1,
			maxAttempts: 3,
		});
		expect(decision.action).toBe("stop");
	});

	test("real timeout flow: classify → retry → failback chain", () => {
		const failureClass = classifyFailure("connection timeout after 30s");
		expect(failureClass).toBe("retryable");

		// First attempt: retry_same.
		let decision = failbackDecision({
			provider: "claude-code",
			model: "claude-opus-4-8",
			failureClass,
			attempt: 1,
			maxAttempts: 3,
		});
		expect(decision.action).toBe("retry_same");

		// Second attempt: still retry_same.
		decision = failbackDecision({
			provider: "claude-code",
			model: "claude-opus-4-8",
			failureClass,
			attempt: 2,
			maxAttempts: 3,
		});
		expect(decision.action).toBe("retry_same");

		// Third attempt: exhausted, failback to next.
		decision = failbackDecision({
			provider: "claude-code",
			model: "claude-opus-4-8",
			failureClass,
			attempt: 3,
			maxAttempts: 3,
		});
		expect(decision.action).toBe("failback_model");
		expect(decision.nextModel).toBe("claude-opus-4-7");
	});

	test("context overflow: classify → stop (never failback)", () => {
		const failureClass = classifyFailure(
			"input exceeds maximum context length of 200000 tokens"
		);
		expect(failureClass).toBe("context_overflow");

		const decision = failbackDecision({
			provider: "claude-code",
			model: "claude-opus-4-8",
			failureClass,
			attempt: 1,
			maxAttempts: 3,
		});
		expect(decision.action).toBe("stop");
		expect(decision.reason).toContain("no failback per §3.4");
	});
});
