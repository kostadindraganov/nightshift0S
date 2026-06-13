/**
 * WHY: Telegram is the first (and for now only) concrete Channel implementation
 * (BLUEPRINT §3.10 item 4). All other channels are plugins for later.
 *
 * Design constraints:
 *   - FAIL-CLOSED: if botTokenRef() or chatId is missing (unconfigured), return
 *     { ok: false, reason: "unconfigured" } WITHOUT touching the network.
 *   - TOKEN SECURITY (BLUEPRINT §3.12.7): the bot token appears ONLY in the URL
 *     passed to deps.send. It MUST NEVER appear in the returned reason string,
 *     any log line, any event payload, or any error message. deps.send is the
 *     injection point for HTTP so tests can fake it without any real fetch.
 *   - No global fetch import — only deps.send crosses the network boundary.
 *     This module compiles and tests cleanly on macOS with no network.
 */

import type { Channel, NotifyMessage } from "./notifier.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal HTTP send abstraction. The production adapter wraps the global fetch;
 * tests pass a fake. This is the ONLY network seam in this module.
 */
export type HttpSend = (
	url: string,
	body: unknown,
) => Promise<{ ok: boolean; status: number }>;

export interface TelegramDeps {
	/**
	 * Returns the Telegram bot token at call time (late-bound so rotations work
	 * without restarting the process). Returns undefined when unconfigured.
	 *
	 * The token is used ONLY to construct the sendMessage URL; it MUST NOT be
	 * placed in any log, event payload, or error string.
	 */
	botTokenRef: () => string | undefined;
	/** Telegram chat_id to deliver messages to. undefined = unconfigured. */
	chatId: string | undefined;
	/** Injectable HTTP transport — production wraps fetch; tests pass a fake. */
	send: HttpSend;
}

// ---------------------------------------------------------------------------
// makeTelegramChannel
// ---------------------------------------------------------------------------

/**
 * Build a Telegram Channel. Returns a Channel whose send():
 *   - Returns { ok: false, reason: "unconfigured" } immediately when
 *     botTokenRef() or chatId is missing — no network call, no token in reason.
 *   - Otherwise POSTs to the Telegram Bot API sendMessage endpoint via
 *     deps.send({ chat_id, text: "title\n\nbody" }).
 *   - Maps the HTTP response: ok=true iff deps.send returns { ok: true }.
 *   - On a non-ok HTTP response, returns { ok: false, reason: "http <status>" }
 *     (status code only — the token never appears in the reason).
 *   - On a deps.send throw, returns { ok: false, reason: "send error" }.
 */
export function makeTelegramChannel(deps: TelegramDeps): Channel {
	return {
		name: "telegram",

		async send(msg: NotifyMessage): Promise<{ ok: boolean; reason?: string }> {
			const token = deps.botTokenRef();
			const { chatId } = deps;

			// FAIL-CLOSED: refuse to attempt network call when unconfigured.
			if (!token || !chatId) {
				return { ok: false, reason: "unconfigured" };
			}

			// Token is only ever interpolated into the URL — never into a string
			// that could end up in a log, reason field, or event payload.
			const url = `https://api.telegram.org/bot${token}/sendMessage`;
			const text = `${msg.title}\n\n${msg.body}`;

			let response: { ok: boolean; status: number };
			try {
				response = await deps.send(url, { chat_id: chatId, text });
			} catch {
				// deps.send threw — network error or timeout. Do NOT include any
				// URL fragment (which could contain the token) in the reason.
				return { ok: false, reason: "send error" };
			}

			if (response.ok) {
				return { ok: true };
			}

			// Return the HTTP status code only — never the URL or token.
			return { ok: false, reason: `http ${response.status}` };
		},
	};
}
