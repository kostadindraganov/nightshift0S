/**
 * Provider capability contract (BLUEPRINT §3.9 + §3.12.13).
 *
 * Capabilities are PROVEN by the conformance harness, not self-declared. The
 * router only uses `proven: Capabilities`; `declared` is the driver's honest
 * self-report and the starting hypothesis for the conformance probes.
 *
 * `structured_output` for CLI drivers means XML-tag extraction over stdout —
 * the result is UNTRUSTED until validated by `extractStructured`; the probe
 * sets the flag only when a round-trip extraction succeeds.
 *
 * `cost_reporting` is claude-code-only today; Codex does NOT report usage.
 */

import type { AuthLane, RunKind } from "../db/columns.ts";

/** All capability axes the router gates on. */
export interface Capabilities {
	/** Driver can sustain an interactive session (stdin/stdout ping-pong). */
	interactive: boolean;
	/** Driver can resume a prior session by sessionId. */
	resume: boolean;
	/** Driver supports forked worktrees / parallel execution within a session. */
	fork: boolean;
	/**
	 * Driver can emit structured JSON inside an XML envelope (<output>…</output>)
	 * that `extractStructured` can reliably parse. UNTRUSTED for CLI drivers until
	 * the conformance probe succeeds.
	 */
	structured_output: boolean;
	/** Driver reports tokens in/out and USD cost per run. */
	cost_reporting: boolean;
	/** Auth lanes this driver can be invoked under. */
	auth: AuthLane[];
	/** Run roles this driver is suitable for. */
	roles: RunKind[];
}

/**
 * A ProviderDriver is a thin adapter over a specific CLI or API backend.
 * The conformance harness calls these methods directly; application code
 * calls them through the router after conformance has run.
 */
export interface ProviderDriver {
	readonly name: string;
	readonly kind: "cli" | "api";
	/** Driver's honest self-report — the hypothesis the probes test. */
	readonly declared: Capabilities;

	/**
	 * Run a single prompt, returning stdout and optional telemetry.
	 * `sessionId` in the return value is required for `resume` to be provable.
	 */
	runOnce(input: {
		prompt: string;
		cwd?: string;
	}): Promise<{
		stdout: string;
		sessionId?: string;
		tokensIn?: number;
		tokensOut?: number;
		costUsd?: number;
	}>;

	/**
	 * Continue an existing session. Only called when `resume` is declared;
	 * the conformance probe verifies it actually works.
	 */
	resumeOnce(input: { sessionId: string; prompt: string }): Promise<{ stdout: string }>;

	/** Returns true when the underlying CLI/API binary is reachable. */
	isAvailable(): Promise<boolean>;
}

/** Single probe result, stored in ProvenReport for auditability. */
export interface ProbeResult {
	capability: keyof Capabilities;
	status: "proven" | "failed" | "skipped";
	evidence: string;
}

/** Full output of `runConformance`: the proven subset and per-probe audit trail. */
export interface ProvenReport {
	driver: string;
	proven: Capabilities;
	results: ProbeResult[];
}
