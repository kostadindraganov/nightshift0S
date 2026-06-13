/**
 * AGENTS.md periodic maintenance cadence (BLUEPRINT 6.B4/6.D4).
 *
 * WHY: Proposes AGENTS.md updates per project on a recurring interval, emitting
 * advisory events (never auto-writing or committing). The proposer is pure
 * (scanRepoSnapshot, proposeAgentsMd); this module adds the interval loop,
 * project enumeration, and file I/O injection.
 *
 * FAIL-CLOSED: one project's error (missing repo, scan failure, LLM failure)
 * does not block the sweep or stop the interval. The loop is fire-and-forget
 * (void async IIFE) so sync errors in setInterval never hang.
 *
 * INERT UNTIL CALLED: startAgentsMdCadence() returns an object with stop();
 * no timers or subscriptions start until the caller invokes start.
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import { listProjects } from "../tasks/tasks.ts";
import { scanRepoSnapshot } from "./repoScan.ts";
import { proposeAgentsMd, type LlmRefine } from "./agentsMd.ts";
import { readFileSync } from "node:fs";

/**
 * Injectable dependencies for the cadence.
 */
export interface AgentsMdCadenceDeps {
	/** DB handle (for listProjects). */
	readonly handle: DbHandle;
	/** Event log (for emitting proposals). */
	readonly log: EventLog;
	/** Interval in milliseconds. */
	readonly intervalMs: number;
	/** Closure that maps repoUrl → local directory path (or null). */
	readonly resolveRepoDir: (repoUrl: string) => string | null;
	/** Optional LLM refine hook (default identity — no LLM required). */
	readonly llmRefine?: LlmRefine;
	/** Optional file reader (default node:fs readFileSync, fail-soft). */
	readonly readFile?: (path: string) => string | null;
}

/**
 * Start the AGENTS.md maintenance cadence. Returns { stop() } to clear the interval.
 * Emits events only when proposal.changed === true; always fail-soft per project.
 */
export function startAgentsMdCadence(deps: AgentsMdCadenceDeps): { stop(): void } {
	const readFileDefault = (path: string): string | null => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			// Fail-soft: missing file or read error.
			return null;
		}
	};

	const readFile = deps.readFile ?? readFileDefault;

	const timerId = setInterval(() => {
		// Fire-and-forget: void the async IIFE so errors inside don't bubble.
		void (async () => {
			try {
				const projects = listProjects(deps.handle);

				for (const project of projects) {
					try {
						const repoDir = deps.resolveRepoDir(project.repoUrl);
						if (repoDir === null) {
							// Unmappable repo — skip silently, no event.
							continue;
						}

						// Scan the repo and read the current AGENTS.md (if any).
						const snapshot = scanRepoSnapshot(repoDir);
						const currentPath = `${repoDir}/AGENTS.md`;
						const current = readFile(currentPath);

						// Propose the updated content.
						const proposal = await proposeAgentsMd({ current, snapshot }, deps.llmRefine);

						// Emit an advisory event only if something changed.
						if (proposal.changed) {
							await deps.log.emitEvent({
								kind: "maintenance.agents_md.proposed",
								projectId: project.id,
								payload: {
									sections: proposal.sections,
									changed: true,
								},
							});
						}
					} catch (err) {
						// Fail-closed: log and continue to the next project.
						// Do NOT emit an event; advisory events only on success.
						console.error(
							`[agentsMdCadence] error processing project ${project.id}:`,
							err instanceof Error ? err.message : String(err),
						);
					}
				}
			} catch (err) {
				// Fail-closed: catch all outer errors (listProjects failure, etc.).
				console.error(
					"[agentsMdCadence] outer sweep error:",
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
