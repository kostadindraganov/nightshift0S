/**
 * WHY: The Notifier is the single fan-out point for human-facing alerts
 * (BLUEPRINT §3.10 item 4, §3.1 Triggers & notifications). It defines two
 * seams:
 *
 *   Channel — a pluggable send surface (Telegram shipped here; others later).
 *   Notifier — routes a NotifyMessage to every configured channel whose
 *     route(kind) predicate returns true, isolating each channel so one
 *     failure never blocks or throws past the others (fail-closed per channel,
 *     not globally).
 *
 * makeEventBridge wires the Notifier to the global EventLog via a TAIL-ONLY
 * subscription (afterSeq = current max seq at construction time, matching the
 * scheduler pattern in src/scheduler/scheduler.ts) so that a process restart
 * does NOT re-deliver historical alerts. Only events whose kind is in
 * interestingKinds AND whose mapEvent returns non-null are forwarded. A bridge
 * error must not crash the loop.
 *
 * SECURITY: per BLUEPRINT §3.12.7, bot tokens / API keys MUST NEVER appear in
 * any event payload, log line, returned reason string, or error message. The
 * Channel.send contract and all concrete implementations enforce this.
 */

import { sql } from "drizzle-orm";
import { events } from "../db/schema.ts";
import type { EventRow } from "../db/schema.ts";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NotifyMessage {
	kind: string;
	taskId?: number | null;
	runId?: number | null;
	projectId?: number | null;
	title: string;
	body: string;
	severity?: "info" | "warn" | "error";
}

export interface Channel {
	name: string;
	send(msg: NotifyMessage): Promise<{ ok: boolean; reason?: string }>;
}

export interface ChannelResult {
	channel: string;
	ok: boolean;
	reason?: string;
}

// ---------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------

export interface NotifierDeps {
	channels: Channel[];
	/** Return true to forward a message of this kind; defaults to always-true. */
	route?: (kind: string) => boolean;
}

/**
 * Fan-out notifier. Each channel.send is fully isolated: a throw is caught and
 * returned as { ok: false, reason: "internal error" } so one broken channel
 * never prevents delivery to the others.
 */
export class Notifier {
	private readonly channels: Channel[];
	private readonly routeFn: (kind: string) => boolean;

	constructor(deps: NotifierDeps) {
		this.channels = deps.channels;
		this.routeFn = deps.route ?? (() => true);
	}

	async notify(msg: NotifyMessage): Promise<ChannelResult[]> {
		if (!this.routeFn(msg.kind)) return [];

		const results: ChannelResult[] = [];
		for (const ch of this.channels) {
			let result: ChannelResult;
			try {
				const sent = await ch.send(msg);
				result = { channel: ch.name, ok: sent.ok, reason: sent.reason };
			} catch (err) {
				// A throw from a channel must never propagate — return it as a failure.
				const reason = err instanceof Error ? err.message : "internal error";
				result = { channel: ch.name, ok: false, reason };
			}
			results.push(result);
		}
		return results;
	}
}

// ---------------------------------------------------------------------------
// Default bridge configuration
// ---------------------------------------------------------------------------

/**
 * The set of event kinds that the default bridge considers interesting.
 * task.state_changed → done/failed/needs_human/awaiting_input surfaces
 * completed work or tasks needing operator attention.
 * run.budget_kill signals a hard budget termination (§3.12.x).
 */
export const DEFAULT_INTERESTING_KINDS: Set<string> = new Set([
	"task.state_changed",
	"run.budget_kill",
]);

/**
 * Default mapEvent: converts task.state_changed (for terminal/stuck states)
 * and run.budget_kill into a NotifyMessage; returns null for all other events
 * or uninteresting state transitions so the bridge stays quiet.
 */
export function defaultMapEvent(e: EventRow): NotifyMessage | null {
	if (e.kind === "task.state_changed") {
		let payload: { to?: string; from?: string } = {};
		try {
			const parsed = JSON.parse(e.payloadJson) as unknown;
			if (parsed !== null && typeof parsed === "object") {
				payload = parsed as { to?: string; from?: string };
			}
		} catch {
			// Malformed payload — treat as non-actionable.
		}
		const { to } = payload;
		if (
			to !== "done" &&
			to !== "failed" &&
			to !== "needs_human" &&
			to !== "awaiting_input"
		) {
			return null;
		}
		const severityMap: Record<string, "info" | "warn" | "error"> = {
			done: "info",
			failed: "error",
			needs_human: "warn",
			awaiting_input: "warn",
		};
		return {
			kind: e.kind,
			taskId: e.taskId ?? null,
			runId: e.runId ?? null,
			projectId: e.projectId ?? null,
			title: `Task ${e.taskId ?? "??"}: ${to}`,
			body: `Task moved to state '${to}'${e.taskId ? ` (id=${e.taskId})` : ""}.`,
			severity: severityMap[to] ?? "info",
		};
	}

	if (e.kind === "run.budget_kill") {
		return {
			kind: e.kind,
			taskId: e.taskId ?? null,
			runId: e.runId ?? null,
			projectId: e.projectId ?? null,
			title: `Run ${e.runId ?? "??"}: budget kill`,
			body: `Run ${e.runId ?? "??"} was terminated due to budget exhaustion.`,
			severity: "error",
		};
	}

	return null;
}

// ---------------------------------------------------------------------------
// makeEventBridge
// ---------------------------------------------------------------------------

export interface EventBridgeDeps {
	handle: DbHandle;
	log: EventLog;
	notifier: Notifier;
	interestingKinds: Set<string>;
	mapEvent: (e: EventRow) => NotifyMessage | null;
}

export interface EventBridge {
	stop(): void;
}

/**
 * Tail-only subscription bridge: reads the current max seq from the events
 * table at construction time (afterSeq = max seq), then subscribes from that
 * point forward so no historical events are re-delivered on restart.
 *
 * For each incoming event whose kind is in interestingKinds and whose mapEvent
 * returns non-null, the message is forwarded to notifier.notify(). Bridge
 * errors are caught and swallowed so a bad mapEvent or a buggy channel never
 * crashes the async loop.
 */
export function makeEventBridge(deps: EventBridgeDeps): EventBridge {
	const { handle, log, notifier, interestingKinds, mapEvent } = deps;

	// TAIL-ONLY: same pattern as startScheduler in src/scheduler/scheduler.ts.
	// Without afterSeq = current max, a restart would replay all historical
	// events and re-deliver every past alert — exactly what we must NOT do.
	const startSeq =
		handle.db
			.select({ max: sql<number>`coalesce(max(${events.seq}), 0)` })
			.from(events)
			.get()?.max ?? 0;

	const subscription = log.subscribe({
		afterSeq: startSeq,
		filter: (e) => interestingKinds.has(e.kind),
	});

	const loop = (async () => {
		for await (const event of subscription) {
			try {
				const msg = mapEvent(event);
				if (msg !== null) {
					await notifier.notify(msg);
				}
			} catch {
				// FAIL-CLOSED: a bridge error must not crash the loop.
				// The next event will still be processed.
			}
		}
	})();

	// Prevent unhandled rejection if the loop itself throws (defensive).
	loop.catch(() => undefined);

	return {
		stop(): void {
			subscription.close();
		},
	};
}
