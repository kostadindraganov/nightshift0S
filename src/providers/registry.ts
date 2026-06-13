/**
 * WHY: The driver registry is the single ordered list of every ProviderDriver
 * the system can route to (BLUEPRINT §3.9 provider matrix, PHASE5C-CONTRACT §6.3).
 * List order IS router priority — `selectDriver` is first-match, so claude-code
 * and codex (the proven primaries) lead, and the new V1.5 drivers follow.
 *
 * INTEGRATION owns this file: builders ship ONLY driver consts (their files are
 * leaf modules). Here we assemble them, pair each with its conformance probe
 * suite and the config knob that enables it, and hand the list to the boot
 * conformance pass (src/server/bootProviders.ts).
 *
 * §3.12.18 reminder: adding a driver changes ROUTING (task-start selection) only;
 * failback within a task stays same-provider — there is no mid-task driver swap.
 *
 * FAIL-CLOSED: a disabled knob or an unavailable binary contributes an all-false
 * proven set, so `selectDriver` naturally never picks it. Enabling a provider is
 * an explicit operator act — every new-driver knob defaults OFF.
 */

import type { ConformanceProbe } from "./conformance.ts";
import { PROBES } from "./conformance.ts";
import type { ProviderDriver } from "./types.ts";
import type { ProviderAuthMode } from "../db/columns.ts";

import { claudeCode } from "./claudeCode.ts";
import { codex } from "./codex.ts";
import { gemini } from "./gemini.ts";
import { opencode } from "./opencode.ts";
import { antigravity } from "./antigravity.ts";
import { openrouter } from "./openrouter.ts";
import { local } from "./local.ts";
import { cma } from "./cma.ts";

/** One registry row: a driver, the probe suite that gates it, and its enable knob. */
export interface DriverRegistryEntry {
	driver: ProviderDriver;
	probes: ConformanceProbe[];
	/** Dotted config path (under providers.*) that must be true to register this driver. */
	enabledKnob: string;
	/**
	 * providers.auth_mode enum is `subscription|api_key` only (db/columns.ts). The
	 * `local` driver's "local" AuthLane has no provider-row auth_mode, so it seeds
	 * as "api_key" (no secret is required; the lane is enforced at routing time).
	 */
	authMode: ProviderAuthMode;
}

/**
 * Ordered registry — list order IS router priority (selectDriver is first-match).
 * The two proven primaries lead; the C3/C4 V1.5 drivers follow in matrix order.
 */
export const DRIVER_REGISTRY: DriverRegistryEntry[] = [
	{ driver: claudeCode, probes: PROBES, enabledKnob: "providers.claudeCodeEnabled", authMode: "subscription" },
	{ driver: codex, probes: PROBES, enabledKnob: "providers.codexEnabled", authMode: "api_key" },
	{ driver: gemini, probes: PROBES, enabledKnob: "providers.geminiEnabled", authMode: "api_key" },
	{ driver: opencode, probes: PROBES, enabledKnob: "providers.opencodeEnabled", authMode: "api_key" },
	{ driver: antigravity, probes: PROBES, enabledKnob: "providers.antigravityEnabled", authMode: "api_key" },
	{ driver: openrouter, probes: PROBES, enabledKnob: "providers.openrouterEnabled", authMode: "api_key" },
	{ driver: local, probes: PROBES, enabledKnob: "providers.localEnabled", authMode: "api_key" },
	// V3 CMA (Anthropic Managed Agents) provider plugin — api driver, default OFF.
	{ driver: cma, probes: PROBES, enabledKnob: "providers.cmaEnabled", authMode: "api_key" },
];
