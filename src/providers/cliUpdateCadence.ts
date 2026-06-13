/**
 * CLI auto-update periodic cadence (BLUEPRINT V3 §7.3).
 *
 * WHY: The CLI updater (cliUpdate.ts) provides status() and update() functions
 * but nothing invokes them on a schedule. This module wraps the updater in a
 * recurring cadence that checks for new versions and optionally runs updates
 * based on operator configuration (config.cliUpdate.enabled).
 *
 * DESIGN:
 *   - INERT UNTIL CALLED: startCliUpdateCadence() returns { stop() } with no
 *     timers running until the caller invokes the function.
 *   - FAIL-CLOSED PER TICK: one target's error doesn't block the sweep or
 *     stop the interval. The loop is fire-and-forget (void async IIFE).
 *   - INJECTABLE UPDATER: the updater is passed in, not imported. Tests can
 *     pass a fake updater that returns predetermined CliStatus arrays.
 *   - SAFE DEFAULTS: DEFAULT_CLI_TARGETS carries no latestArgs/updateArgs, so
 *     updateAvailable is always false and update() returns {ok:false,error:'no
 *     update command'} without executing. Even with runUpdates=true, the cadence
 *     is fail-soft.
 *   - EMITS ON EVERY TICK: every intervalMs, call status() for the configured
 *     targets and emit a 'providers.cli_status' event with the summary. If
 *     runUpdates is true and a target advertises an update, attempt update().
 */

import type { CliStatus, CliTarget } from "./cliUpdate.ts";
import { DEFAULT_CLI_TARGETS } from "./cliUpdate.ts";
import type { EventLog } from "../events/events.ts";

/**
 * Injectable dependencies for the CLI update cadence.
 */
export interface StartCliUpdateCadenceDeps {
	/** The CLI updater (status + update methods). */
	readonly updater: {
		status(targets: CliTarget[]): Promise<CliStatus[]>;
		update(target: CliTarget): Promise<{ ok: boolean; error?: string }>;
	};
	/** Interval in milliseconds between status checks. */
	readonly intervalMs: number;
	/** Event log for emitting status summaries. */
	readonly log: EventLog;
	/** If true, call updater.update() for targets with updateAvailable=true. */
	readonly runUpdates?: boolean;
}

/**
 * Start the CLI auto-update cadence.
 * Returns { stop() } to clear the interval; no timers run until called.
 *
 * Every intervalMs:
 *   1. Call updater.status() for DEFAULT_CLI_TARGETS.
 *   2. Emit a 'providers.cli_status' event with the status array.
 *   3. If runUpdates=true and a target advertises an update, call
 *      updater.update() for that target (fire-and-forget, no blocking).
 *
 * Fail-closed: one target's error doesn't block the sweep or stop the loop.
 */
export function startCliUpdateCadence(deps: StartCliUpdateCadenceDeps): { stop(): void } {
	const timerId = setInterval(() => {
		// Fire-and-forget: void the async IIFE so errors inside don't bubble.
		void (async () => {
			try {
				// Check status for all configured targets.
				const statuses = await deps.updater.status(DEFAULT_CLI_TARGETS);

				// Emit the status summary to the event log.
				await deps.log.emitEvent({
					kind: "providers.cli_status",
					payload: {
						statuses,
						timestamp: new Date().toISOString(),
					},
				});

				// If updates are enabled, process targets that advertise an update.
				if (deps.runUpdates) {
					for (const status of statuses) {
						if (status.updateAvailable) {
							// Find the target definition so we can call update() with it.
							const target = DEFAULT_CLI_TARGETS.find(
								(t) => t.provider === status.provider && t.bin === status.bin,
							);

							if (target) {
								try {
									const result = await deps.updater.update(target);
									// Emit an update attempt event (success or failure).
									await deps.log.emitEvent({
										kind: "providers.cli_update_attempted",
										payload: {
											provider: status.provider,
											bin: status.bin,
											ok: result.ok,
											error: result.error,
											timestamp: new Date().toISOString(),
										},
									});
								} catch (err) {
									// Fail-closed: log but don't crash the cadence.
									console.error(
										`[cliUpdateCadence] update failed for ${status.provider}/${status.bin}:`,
										err instanceof Error ? err.message : String(err),
									);
								}
							}
						}
					}
				}
			} catch (err) {
				// Fail-closed: catch all outer errors (status() failure, emitEvent failure, etc.).
				console.error(
					"[cliUpdateCadence] tick error:",
					err instanceof Error ? err.message : String(err),
				);
			}
		})();
	}, deps.intervalMs);

	return {
		stop(): void {
			clearInterval(timerId);
		},
	};
}
