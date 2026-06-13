/**
 * WHY: Failback policy (BLUEPRINT §3.12.18, §3.4 model resilience) is a PURE
 * policy module — no DB, no events, no imports from capacity.ts. It answers
 * two distinct questions:
 *
 *   1. WITHIN a single task run: given a failure class and attempt number, what
 *      should the scheduler do next? (failbackDecision)
 *
 *   2. BETWEEN tasks on reassign: given this task's prior coder-run history,
 *      which providers should the routing policy avoid? (routingDecision)
 *
 * The separation from capacity.ts is intentional: capacity.ts owns quota/circuit
 * breaker state per-provider; failback.ts owns the model-selection policy. They
 * both classify exit reasons (classifyFailure mirrors signalFromExitReason in
 * vocabulary but is finer-grained and returns a FailureClass, not a
 * CapacitySignalKind). See src/providers/capacity.ts signalFromExitReason for
 * the capacity-side analog — keep keyword sets in sync manually if you extend
 * either classifier.
 *
 * Policy table (ALLOWED_TRANSITIONS) is the authoritative source of truth for
 * §3.4:
 *   - rate_limit: capacity cooldown owns this — do NOT failback across models.
 *   - auth:       dead credential for the whole provider — must NOT failback.
 *   - context_overflow: the task itself is too large; no other model fixes it.
 *   - retryable:  transient; retry same model, failback when attempts exhausted.
 *   - unknown:    conservatively stop; do not guess.
 */

// ---------------------------------------------------------------------------
// FailureClass
// ---------------------------------------------------------------------------

/** Finer-grained classification than capacity.ts CapacitySignalKind. */
export type FailureClass =
	| "retryable"
	| "rate_limit"
	| "auth"
	| "context_overflow"
	| "unknown";

// ---------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------

/**
 * Map a raw `runs.exit_reason` string (or null) to a FailureClass.
 *
 * Classification priority (first match wins):
 *   1. context length / token window / context overflow → "context_overflow"
 *   2. 429 / rate limit                                → "rate_limit"
 *   3. 401 / 403 / auth / quota / usage limit / key   → "auth"
 *   4. transient / network / 5xx / timeout             → "retryable"
 *   5. null or nothing matched                         → "unknown"
 *
 * NOTE: context_overflow is checked BEFORE auth because some providers embed
 * "token" in both auth error strings and context-window error strings; matching
 * context signals first avoids mis-classifying a window overflow as auth.
 */
export function classifyFailure(exitReason: string | null): FailureClass {
	if (exitReason === null) return "unknown";
	const r = exitReason.toLowerCase();

	// 1. Context / token window overflow.
	if (
		r.includes("context length") ||
		r.includes("context_length") ||
		r.includes("token window") ||
		r.includes("token_window") ||
		r.includes("context overflow") ||
		r.includes("context_overflow") ||
		r.includes("maximum context") ||
		r.includes("prompt is too long") ||
		r.includes("too many tokens")
	) {
		return "context_overflow";
	}

	// 2. Rate limit (429).
	if (
		r.includes("429") ||
		r.includes("rate_limit") ||
		r.includes("rate limit") ||
		r.includes("too many requests")
	) {
		return "rate_limit";
	}

	// 3. Auth / credential / quota exhaustion.
	if (
		r.includes("401") ||
		r.includes("403") ||
		r.includes("auth_limit") ||
		r.includes("auth limit") ||
		r.includes("authentication_error") ||
		r.includes("unauthorized") ||
		r.includes("invalid_api_key") ||
		r.includes("invalid api key") ||
		r.includes("quota") ||
		r.includes("usage limit") ||
		r.includes("usage_limit")
	) {
		return "auth";
	}

	// 4. Transient / network / server-side errors.
	if (
		r.includes("transient") ||
		r.includes("network") ||
		r.includes("connection") ||
		r.includes("timeout") ||
		r.includes("timed out") ||
		r.includes("econnreset") ||
		r.includes("econnrefused") ||
		r.includes("enotfound") ||
		r.includes("socket") ||
		r.includes("500") ||
		r.includes("502") ||
		r.includes("503") ||
		r.includes("504") ||
		r.includes("server error") ||
		r.includes("internal error") ||
		r.includes("overloaded")
	) {
		return "retryable";
	}

	return "unknown";
}

// ---------------------------------------------------------------------------
// MODEL_FAMILIES
// ---------------------------------------------------------------------------

/**
 * Ordered within-vendor failback chains keyed by provider name.
 * Each array is ordered best→fallback; failbackDecision walks forward from the
 * current model to the NEXT entry. Never cross vendor boundaries.
 *
 * Operator-tunable: replace this object in integration/config to suit the
 * actual deployed provider set.
 */
export const MODEL_FAMILIES: Record<string, string[]> = {
	"claude-code": [
		"claude-opus-4-8",
		"claude-opus-4-7",
		"claude-sonnet-4-6",
	],
	"codex": [
		"o3",
		"o4-mini",
		"gpt-4o",
	],
	"gemini": [
		"gemini-2-5-pro",
		"gemini-2-0-flash",
		"gemini-1-5-pro",
	],
};

// ---------------------------------------------------------------------------
// ALLOWED_TRANSITIONS — explicit policy table (§3.4)
// ---------------------------------------------------------------------------

/**
 * The authoritative policy table for §3.4. Maps each FailureClass to a base
 * action. failbackDecision uses this table first, then refines based on
 * attempt count and chain position.
 *
 * rate_limit  → "stop": capacity.ts cooldown owns this class; the capacity
 *               pool is already in cooldown so spawning on any model at this
 *               provider is blocked. No point failing back within the vendor.
 * auth        → "stop": a dead credential or exhausted subscription affects
 *               ALL models at this provider — failback cannot help.
 * context_overflow → "stop": the task itself exceeds the context window;
 *               a smaller/cheaper model in the same family will have an equal
 *               or shorter window, so failback makes things worse.
 * retryable   → "retry_same": transient; keep the same model while attempts
 *               remain, then failback_model when exhausted.
 * unknown     → "stop": conservatively refuse to guess; do not waste quota.
 */
export const ALLOWED_TRANSITIONS: Record<FailureClass, "retry_same" | "failback_model" | "stop"> =
	{
		retryable: "retry_same",
		rate_limit: "stop",
		auth: "stop",
		context_overflow: "stop",
		unknown: "stop",
	};

// ---------------------------------------------------------------------------
// failbackDecision — within-task action
// ---------------------------------------------------------------------------

export interface FailbackInput {
	/** Provider name (must match a key in MODEL_FAMILIES to enable failback). */
	provider: string;
	/** The model that just failed. */
	model: string;
	/** Classified failure class (from classifyFailure). */
	failureClass: FailureClass;
	/** 1-based attempt number that just failed. */
	attempt: number;
	/** Maximum attempts before exhausting retry_same and moving to failback. */
	maxAttempts: number;
}

export interface FailbackDecision {
	action: "retry_same" | "failback_model" | "stop";
	/** Set when action === "failback_model". The next model in the chain. */
	nextModel?: string;
	/** Human-readable explanation for logs / scheduler skip reason. */
	reason: string;
}

/**
 * Compute the per-task, per-failure action.
 *
 * Algorithm:
 *   1. Consult ALLOWED_TRANSITIONS for the base policy.
 *   2. If base === "stop" → stop immediately with a class-specific reason.
 *   3. If base === "retry_same":
 *        attempt < maxAttempts → retry_same.
 *        attempt >= maxAttempts → escalate to failback_model logic.
 *   4. failback_model: find `model` in MODEL_FAMILIES[provider], take the
 *      NEXT entry. If none (chain exhausted, unknown provider, or model not in
 *      chain) → stop.
 *
 * NEVER crosses vendor: the chain for `provider` is consulted exclusively.
 */
export function failbackDecision(input: FailbackInput): FailbackDecision {
	const base = ALLOWED_TRANSITIONS[input.failureClass];

	if (base === "stop") {
		return {
			action: "stop",
			reason: `failureClass=${input.failureClass} policy=stop (no failback per §3.4)`,
		};
	}

	// base === "retry_same": honour while attempts remain.
	if (input.attempt < input.maxAttempts) {
		return {
			action: "retry_same",
			reason: `failureClass=${input.failureClass} attempt=${input.attempt}/${input.maxAttempts} retrying same model`,
		};
	}

	// Attempts exhausted — escalate to failback_model.
	const chain = MODEL_FAMILIES[input.provider];
	if (chain === undefined) {
		return {
			action: "stop",
			reason: `attempts exhausted; provider="${input.provider}" not in MODEL_FAMILIES — cannot failback`,
		};
	}

	const idx = chain.indexOf(input.model);
	if (idx === -1) {
		return {
			action: "stop",
			reason: `attempts exhausted; model="${input.model}" not found in chain for provider="${input.provider}"`,
		};
	}

	const nextModel = chain[idx + 1];
	if (nextModel === undefined) {
		return {
			action: "stop",
			reason: `attempts exhausted; model="${input.model}" is last in chain for provider="${input.provider}" — chain exhausted`,
		};
	}

	return {
		action: "failback_model",
		nextModel,
		reason: `attempts exhausted; failing back from "${input.model}" to "${nextModel}" within provider="${input.provider}"`,
	};
}

// ---------------------------------------------------------------------------
// routingDecision — between-task reassign policy (§3.12.18)
// ---------------------------------------------------------------------------

export interface PriorCoderRun {
	provider: string;
	model: string;
	exitReason: string | null;
	state: string;
}

export interface RoutingDecision {
	/** Providers to exclude on the next assignment attempt. */
	avoidProviders: string[];
	/** Human-readable explanation. */
	reason: string;
}

/**
 * Between-task reassign policy (§3.12.18): collect the providers of FAILED
 * prior coder runs and mark them as avoid candidates so the routing layer can
 * skip them on the next assignment. A run is "failed" when its `state` is
 * "failed" (terminal failure, not killed/interrupted/succeeded).
 *
 * Only the providers of failed runs matter — succeeded/killed/interrupted runs
 * carry no negative signal about the provider. Duplicates are collapsed so the
 * returned set is unique.
 *
 * The caller (resolveSpawn in scheduler.ts) merges avoidProviders with
 * capacity decisions to arrive at a final provider choice.
 */
export function routingDecision(input: { priorCoderRuns: PriorCoderRun[] }): RoutingDecision {
	const failedProviders = new Set<string>();

	for (const run of input.priorCoderRuns) {
		if (run.state === "failed") {
			failedProviders.add(run.provider);
		}
	}

	const avoidProviders = [...failedProviders];

	if (avoidProviders.length === 0) {
		return {
			avoidProviders: [],
			reason: "no prior failed coder runs — no providers to avoid",
		};
	}

	return {
		avoidProviders,
		reason: `avoiding providers with prior failed runs: ${avoidProviders.join(", ")}`,
	};
}
