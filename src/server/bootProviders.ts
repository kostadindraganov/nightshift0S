/**
 * WHY: The boot-time provider conformance pass (PHASE5C-CONTRACT §6.3 boot flow).
 * "Capabilities are PROVEN, not declared" (BLUEPRINT §3.12.13/.30): before any
 * driver can be ROUTED to, the harness must demonstrate each capability at
 * runtime. This module walks the DRIVER_REGISTRY, and for every entry whose
 * enable knob is ON:
 *
 *   1. seeds a `providers` row via `ensureProvider` (so capacity's canSpawn gate
 *      has a row — it fail-closes on unknown providers),
 *   2. runs `runConformance(driver, probes)`,
 *   3. records the ProvenReport to `providers.capabilities_json`,
 *   4. keeps `{driver, proven}` in the in-memory list handed to `selectDriver`.
 *
 * Disabled knobs and unavailable binaries contribute an all-false proven set and
 * are therefore never selectable (fail-closed). This runs ONLY on the dev/host
 * boot path (main.ts `import.meta.main`) — never inside `createServer`, so the
 * test suite never spawns a CLI probe or touches the network.
 *
 * §3.12.18: this changes ROUTING only (task-start selection); failback within a
 * task stays same-provider.
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { NightshiftConfig } from "../config/config.ts";
import type { Capabilities, ProviderDriver } from "../providers/types.ts";
import { DRIVER_REGISTRY } from "../providers/registry.ts";
import { runConformance, recordCapabilities } from "../providers/conformance.ts";
import { ensureProvider, type CapacityDeps } from "../providers/capacity.ts";

/** The router-facing list: a proven driver and its demonstrated capability set. */
export interface RoutableDriver {
	driver: ProviderDriver;
	proven: Capabilities;
}

/**
 * Read a dotted `providers.*` boolean knob from config. Only the providers
 * section is consulted; an unknown leaf is treated as OFF (fail-closed).
 */
function knobEnabled(config: NightshiftConfig, dottedKnob: string): boolean {
	const [section, key] = dottedKnob.split(".");
	if (section !== "providers" || key === undefined) return false;
	const val = (config.providers as Record<string, unknown>)[key];
	return val === true;
}

/**
 * Run the boot conformance pass. For each enabled registry entry: seed the
 * provider row, prove capabilities, persist them, and collect the routable
 * driver. Disabled/unavailable drivers are skipped (they would only contribute
 * all-false proven sets that the router never selects anyway).
 *
 * Returns the ordered list for `selectDriver` (registry order = router priority).
 */
export async function bootProviderConformance(deps: {
	handle: DbHandle;
	log: EventLog;
	config: NightshiftConfig;
}): Promise<RoutableDriver[]> {
	const { handle, log, config } = deps;
	const capacityDeps: CapacityDeps = {
		handle,
		log,
		now: () => new Date(),
		cooldownSeconds: config.capacity.cooldownSeconds,
		overflowToApiKey: config.capacity.overflowToApiKey,
	};

	const routable: RoutableDriver[] = [];

	for (const entry of DRIVER_REGISTRY) {
		if (!knobEnabled(config, entry.enabledKnob)) continue;

		// Seed the capacity row (canSpawn fail-closes on unknown providers).
		await ensureProvider(capacityDeps, {
			name: entry.driver.name,
			kind: entry.driver.kind,
			authMode: entry.authMode,
			concurrencyCap: config.concurrency.perProviderCap,
		});

		// Prove, persist, collect.
		const report = await runConformance(entry.driver, entry.probes);
		await recordCapabilities(handle, entry.driver.name, report);
		routable.push({ driver: entry.driver, proven: report.proven });
	}

	return routable;
}
