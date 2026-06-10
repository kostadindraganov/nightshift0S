/**
 * Lifecycle hook bridge (task 2.5 — SPEC-STATE-MACHINES §2).
 *
 * Translates raw Claude Code lifecycle events (posted by ops/hook.sh) into run
 * state transitions. Every incoming hook is persisted as a `run.hook.*` event
 * row first — observability and idempotency anchor. Only then is the run state
 * machine driven.
 *
 * Lost-race / illegal-transition results from `transitionRun` are non-fatal:
 * a hook can legitimately arrive in an unexpected state (replay, duplicate
 * delivery, out-of-order). Log and return `transitioned:false`; never throw.
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import { transitionRun } from "./transitions.ts";

// ---------------------------------------------------------------------------
// Types

export interface HookEvent {
	kind: string;
	payload: unknown;
}

/** Blocking tools that pause the run pending a user reply. */
const BLOCKING_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

// ---------------------------------------------------------------------------
// ingestHookEvent

/**
 * Persist the raw hook and — for known lifecycle kinds — drive the run state
 * machine.
 *
 * Idempotent under duplicate delivery: a lost_race on a repeated hook is
 * silently absorbed (the state is already correct).
 */
export async function ingestHookEvent(
	handle: DbHandle,
	log: EventLog,
	runId: number,
	ev: HookEvent,
): Promise<{ transitioned: boolean; to?: string }> {
	// (1) Always persist the raw hook as an event row — observability first.
	// emitEvent goes through enqueueWrite internally.
	await log.emitEvent({
		runId,
		kind: `run.hook.${ev.kind}`,
		payload: ev.payload,
	});

	// (2) Map lifecycle kind to a run transition.
	const kind = ev.kind;
	const payload = ev.payload as Record<string, unknown>;

	// SessionStart: starting → running (also captures session_id).
	if (kind === "SessionStart") {
		const sessionId =
			typeof payload?.session_id === "string" ? payload.session_id : undefined;
		const result = await transitionRun(handle, log, {
			runId,
			to: "running",
			expectedFrom: "starting",
			actor: "hook:SessionStart",
			extra: sessionId !== undefined ? { sessionId } : undefined,
		});
		if (!result.ok) {
			// Non-fatal: log and carry on.
			console.warn(`[hookBridge] SessionStart lost_race/illegal for run ${runId}:`, result.reason);
			return { transitioned: false };
		}
		return { transitioned: true, to: "running" };
	}

	// PreToolUse with a blocking tool: running → awaiting_input.
	if (kind === "PreToolUse") {
		const toolName = payload?.tool_name;
		if (typeof toolName === "string" && BLOCKING_TOOLS.has(toolName)) {
			const result = await transitionRun(handle, log, {
				runId,
				to: "awaiting_input",
				expectedFrom: "running",
				actor: "hook:PreToolUse",
			});
			if (!result.ok) {
				console.warn(
					`[hookBridge] PreToolUse(${toolName}) lost_race/illegal for run ${runId}:`,
					result.reason,
				);
				return { transitioned: false };
			}
			return { transitioned: true, to: "awaiting_input" };
		}
		// Non-blocking tool — just logged.
		return { transitioned: false };
	}

	// PostToolUse with a blocking tool OR UserPromptSubmit: awaiting_input → running.
	if (kind === "PostToolUse") {
		const toolName = payload?.tool_name;
		if (typeof toolName === "string" && BLOCKING_TOOLS.has(toolName)) {
			const result = await transitionRun(handle, log, {
				runId,
				to: "running",
				expectedFrom: "awaiting_input",
				actor: "hook:PostToolUse",
			});
			if (!result.ok) {
				console.warn(
					`[hookBridge] PostToolUse(${toolName}) lost_race/illegal for run ${runId}:`,
					result.reason,
				);
				return { transitioned: false };
			}
			return { transitioned: true, to: "running" };
		}
		return { transitioned: false };
	}

	if (kind === "UserPromptSubmit") {
		const result = await transitionRun(handle, log, {
			runId,
			to: "running",
			expectedFrom: "awaiting_input",
			actor: "hook:UserPromptSubmit",
		});
		if (!result.ok) {
			console.warn(
				`[hookBridge] UserPromptSubmit lost_race/illegal for run ${runId}:`,
				result.reason,
			);
			return { transitioned: false };
		}
		return { transitioned: true, to: "running" };
	}

	// Stop: check for background tasks still running.
	if (kind === "Stop") {
		const backgroundTasks = payload?.background_tasks;
		const hasActiveBackground =
			Array.isArray(backgroundTasks) &&
			backgroundTasks.some(
				(t: unknown) =>
					typeof t === "object" && t !== null && (t as Record<string, unknown>).status === "running",
			);

		if (hasActiveBackground) {
			// Interim stop with background agents still alive: running → background_waiting.
			const result = await transitionRun(handle, log, {
				runId,
				to: "background_waiting",
				expectedFrom: "running",
				actor: "hook:Stop",
			});
			if (!result.ok) {
				console.warn(
					`[hookBridge] Stop(background) lost_race/illegal for run ${runId}:`,
					result.reason,
				);
				return { transitioned: false };
			}
			return { transitioned: true, to: "background_waiting" };
		}

		// Normal stop: running → finishing (or background_waiting → finishing when all returned).
		// Try running first, then background_waiting.
		let result = await transitionRun(handle, log, {
			runId,
			to: "finishing",
			expectedFrom: "running",
			actor: "hook:Stop",
		});
		if (!result.ok) {
			// Try from background_waiting (all subagents returned path).
			result = await transitionRun(handle, log, {
				runId,
				to: "finishing",
				expectedFrom: "background_waiting",
				actor: "hook:Stop",
			});
		}
		if (!result.ok) {
			console.warn(`[hookBridge] Stop lost_race/illegal for run ${runId}:`, result.reason);
			return { transitioned: false };
		}
		return { transitioned: true, to: "finishing" };
	}

	// Notification and all other kinds: just logged, no transition.
	return { transitioned: false };
}
