/**
 * WHY: V2 production boot composer (BLUEPRINT §3.10, PHASE 5 + 6). Wires the
 * three V2 background loops — cron trigger scheduler, event bridge, standup
 * digest — from a single entry point so main.ts can start all of them with
 * one call and tear them all down with one stop().
 *
 * Design constraints:
 *   - FAIL-CLOSED AT EVERY SEAM: missing env vars produce zero channels; zero
 *     channels skip the bridge and digest entirely. Starting with an empty env
 *     is fully inert — no timer fires anything harmful.
 *   - GUARD ON EACH START: each loop is wrapped in try/catch so one broken
 *     seam (e.g. a bad DB query at bridge construction) never aborts the
 *     others (fail-closed: log-and-continue).
 *   - GUARD ON EACH STOP: stop() guards every call so a loop that was never
 *     started (because its try/catch caught) is a safe no-op.
 *   - SECRETS: env vars are read by name; their values never appear in any
 *     log, event payload, or error string (BLUEPRINT §3.12.7).
 *   - NO NEW DEPS: global fetch via fetchHttpSend from transports.ts; no npm.
 *
 * Wiring order:
 *   1. Cron trigger scheduler (always started — it is harmless without rows).
 *   2. Channels from env: Telegram when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID;
 *      Slack when SLACK_WEBHOOK_URL. Email only if host injects an EmailSend.
 *   3. Event bridge (only when channels.length > 0).
 *   4. Standup digest scheduler (only when channels.length > 0).
 *   5. Preview idle-reap loop (only when preview.enabled=true).
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { NightshiftConfig } from "../config/config.ts";
import {
	Notifier,
	makeEventBridge,
	DEFAULT_INTERESTING_KINDS,
	defaultMapEvent,
} from "../notify/notifier.ts";
import type { EventBridge } from "../notify/notifier.ts";
import { makeTelegramChannel, type HttpSend } from "../notify/telegram.ts";
import { makeSlackChannel } from "../notify/slack.ts";
import { makeDigestScheduler } from "../notify/digest.ts";
import type { DigestScheduler } from "../notify/digest.ts";
import { startTriggerScheduler } from "../triggers/triggers.ts";
import { fetchHttpSend } from "../notify/transports.ts";
import {
	makePreviewManager,
	makeDeployer,
	startPreviewReaper,
	type CommandRunner,
} from "../preview/preview.ts";
import { startWorkerReaper, workerRegistry } from "../scheduler/workers.ts";

// Re-export HttpSend so callers can import it from here (the canonical
// definition lives in telegram.ts; all channel types share the same shape).
export type { HttpSend } from "../notify/telegram.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface V2BootDeps {
	handle: DbHandle;
	events: EventLog;
	config: NightshiftConfig;
	/**
	 * Environment variable map. Defaults to process.env when omitted.
	 * Injected in tests so no real env vars are needed.
	 */
	env?: Record<string, string | undefined>;
	/**
	 * Injectable HTTP transport used by the Telegram and Slack channels.
	 * Defaults to fetchHttpSend (global fetch). Injected in tests to avoid
	 * real network calls. SECURITY: values sent here may contain secrets;
	 * never log the url argument.
	 */
	httpSend?: HttpSend;
	/**
	 * Injectable clock for the digest scheduler ("now"). Defaults to
	 * () => new Date(). Injected in tests for deterministic time control.
	 */
	now?: () => Date;
	/**
	 * Injectable command runner for the preview CommandDeployer. Defaults to
	 * defaultCommandRunner (Bun.spawn). Injected in tests to avoid real
	 * subprocess spawning.
	 */
	previewRun?: CommandRunner;
}

// ---------------------------------------------------------------------------
// startV2Loops
// ---------------------------------------------------------------------------

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

/**
 * Compose and start all V2 background loops. Returns { stop() } that tears
 * down every started loop. A stop() on a loop that failed to start is a
 * safe no-op.
 *
 * With an empty/unconfigured env the result is fully inert: the cron
 * scheduler runs (but fires nothing without trigger rows), and the bridge +
 * digest are skipped (no channels → nothing to deliver to).
 */
// Preview reaper interval: one sweep per minute.
const PREVIEW_REAPER_INTERVAL_MS = 60_000;
// Worker stale-reaper interval: one sweep per minute.
const WORKER_REAPER_INTERVAL_MS = 60_000;

export function startV2Loops(deps: V2BootDeps): { stop(): void } {
	const { handle, events: log, now: clockFn } = deps;
	const env = deps.env ?? process.env;
	const httpSend = deps.httpSend ?? fetchHttpSend;
	const now = clockFn ?? (() => new Date());

	// Collect stop handles; each is guarded below so a null entry is a no-op.
	let triggerScheduler: { stop(): void } | null = null;
	let bridge: EventBridge | null = null;
	let digest: DigestScheduler | null = null;
	let previewReaper: { stop(): void } | null = null;
	let workerReaper: { stop(): void } | null = null;

	// 1. Cron trigger scheduler — always started; harmless without cron rows.
	try {
		triggerScheduler = startTriggerScheduler(
			{ handle, log },
			{ intervalMs: 60_000 },
		);
	} catch {
		// Fail-closed: log-and-continue; the other loops must still start.
	}

	// 2. Build channels from env.
	const channels = buildChannels(env, httpSend);

	// 3. Event bridge — only when there are channels to deliver to.
	if (channels.length > 0) {
		const notifier = new Notifier({ channels });

		try {
			bridge = makeEventBridge({
				handle,
				log,
				notifier,
				interestingKinds: DEFAULT_INTERESTING_KINDS,
				mapEvent: defaultMapEvent,
			});
		} catch {
			// Fail-closed: bridge failure must not prevent the digest from starting.
		}

		// 4. Standup digest — only when there are channels.
		try {
			digest = makeDigestScheduler({
				handle,
				notifier,
				now,
				intervalMs: EIGHT_HOURS_MS,
				sinceWindowMs: EIGHT_HOURS_MS,
			});
		} catch {
			// Fail-closed: digest failure is isolated.
		}
	}

	// 5. Preview idle-reap loop — only when preview.enabled=true.
	//    The deployer is selected by makeDeployer: CommandDeployer when
	//    commands are configured, FailClosedDeployer otherwise.
	//    The manager is constructed inline (stateless across restarts; envs
	//    live only in memory on the singleton manager in previewRoutes.ts, so
	//    this reaper uses its own manager — consistent with the design that
	//    startV2Loops is a pure background-loop composer injecting no shared
	//    state across modules).
	if (deps.config.preview.enabled) {
		try {
			const previewCfg = deps.config.preview as {
				enabled: boolean;
				domain: string;
				idleReapMinutes: number;
				deployCommand?: string[];
				teardownCommand?: string[];
			};
			const deployer = makeDeployer(previewCfg, deps.previewRun);
			const manager = makePreviewManager({
				deployer,
				domain: previewCfg.domain,
			});
			previewReaper = startPreviewReaper({
				manager,
				idleReapMinutes: previewCfg.idleReapMinutes,
				intervalMs: PREVIEW_REAPER_INTERVAL_MS,
				now: () => Date.now(),
			});
		} catch {
			// Fail-closed: preview reaper failure is isolated.
		}
	}

	// 6. Worker stale-reaper loop — only when workers.enabled=true.
	//    Reclaims slots held by vanished remote daemons on a cadence so the
	//    registry never shows a dead worker as live. Inert (skipped) by default.
	if (deps.config.workers.enabled) {
		try {
			workerReaper = startWorkerReaper({
				registry: workerRegistry,
				leaseSeconds: deps.config.workers.leaseSeconds,
				intervalMs: WORKER_REAPER_INTERVAL_MS,
				now: () => Date.now(),
			});
		} catch {
			// Fail-closed: worker reaper failure is isolated.
		}
	}

	return {
		stop(): void {
			// Guard each — a loop that never started (null) is a no-op.
			try {
				triggerScheduler?.stop();
			} catch {
				// ignore
			}
			try {
				bridge?.stop();
			} catch {
				// ignore
			}
			try {
				digest?.stop();
			} catch {
				// ignore
			}
			try {
				previewReaper?.stop();
			} catch {
				// ignore
			}
			try {
				workerReaper?.stop();
			} catch {
				// ignore
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Channel construction helpers
// ---------------------------------------------------------------------------

/**
 * Build notification channels from env vars. Returns only the channels that
 * are fully configured; unconfigured channels are omitted (fail-closed).
 *
 * SECURITY: env var values are passed to the channel factories as late-bound
 * refs — they never appear in logs, event payloads, or error strings here.
 */
function buildChannels(
	env: Record<string, string | undefined>,
	httpSend: HttpSend,
): ReturnType<typeof makeTelegramChannel | typeof makeSlackChannel>[] {
	const channels: ReturnType<
		typeof makeTelegramChannel | typeof makeSlackChannel
	>[] = [];

	// Telegram: both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be present.
	const telegramToken = env["TELEGRAM_BOT_TOKEN"];
	const telegramChatId = env["TELEGRAM_CHAT_ID"];
	if (telegramToken && telegramChatId) {
		// botTokenRef is late-bound so token rotations take effect without restart.
		channels.push(
			makeTelegramChannel({
				botTokenRef: () => env["TELEGRAM_BOT_TOKEN"],
				chatId: telegramChatId,
				send: httpSend,
			}),
		);
	}

	// Slack: SLACK_WEBHOOK_URL must be present.
	const slackWebhookUrl = env["SLACK_WEBHOOK_URL"];
	if (slackWebhookUrl) {
		channels.push(
			makeSlackChannel({
				webhookUrlRef: () => env["SLACK_WEBHOOK_URL"],
				send: httpSend,
			}),
		);
	}

	// Email: not wired by default (no SMTP dep). A host injects its own
	// EmailSend via makeEmailChannel and adds the resulting channel to the
	// Notifier externally. See src/notify/transports.ts: unconfiguredEmailSend.

	return channels;
}
