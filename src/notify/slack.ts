/**
 * WHY: Slack incoming-webhook Channel for the Notifier fan-out (BLUEPRINT
 * §3.10 item 4). Mirrors the Telegram channel discipline exactly:
 *
 *   - FAIL-CLOSED: if webhookUrlRef() returns undefined (unconfigured), return
 *     { ok: false, reason: "unconfigured" } without touching the network.
 *   - SECRET SECURITY (BLUEPRINT §3.12.7): the webhook URL is a secret. It
 *     appears ONLY in the deps.send call, NEVER in a returned reason string,
 *     log line, event payload, or error message.
 *   - No global fetch — only deps.send crosses the network boundary so tests
 *     can inject a fake and this module compiles cleanly without network access.
 */

import type { Channel, NotifyMessage } from "./notifier.ts";
import type { HttpSend } from "./telegram.ts";

// Re-export HttpSend so consumers can import it from here too.
export type { HttpSend };

export interface SlackDeps {
	/**
	 * Late-bound accessor for the Slack incoming-webhook URL. Returning undefined
	 * means unconfigured — the channel will refuse to send without calling
	 * deps.send. The URL is a secret: it MUST NOT appear in any log, reason
	 * string, or event payload.
	 */
	webhookUrlRef: () => string | undefined;
	/** Injectable HTTP transport — production wraps fetch; tests pass a fake. */
	send: HttpSend;
}

/**
 * Build a Slack Channel backed by an incoming webhook. Returns a Channel whose
 * send():
 *   - Returns { ok: false, reason: "unconfigured" } immediately when
 *     webhookUrlRef() is missing — no network call, webhook URL not in reason.
 *   - Otherwise POSTs { text: "title\n\nbody" } via deps.send to the webhook URL.
 *   - Maps the HTTP response: ok=true iff deps.send returns { ok: true }.
 *   - On a non-ok HTTP response returns { ok: false, reason: "http <status>" }
 *     (status code only — the webhook URL never appears in the reason).
 *   - On a deps.send throw, returns { ok: false, reason: "send error" }.
 */
export function makeSlackChannel(deps: SlackDeps): Channel {
	return {
		name: "slack",

		async send(msg: NotifyMessage): Promise<{ ok: boolean; reason?: string }> {
			const webhookUrl = deps.webhookUrlRef();

			// FAIL-CLOSED: refuse to attempt any network call when unconfigured.
			// The webhook URL must NOT appear in the reason string.
			if (!webhookUrl) {
				return { ok: false, reason: "unconfigured" };
			}

			const text = `${msg.title}\n\n${msg.body}`;

			let response: { ok: boolean; status: number };
			try {
				// Webhook URL appears ONLY here — never in logs, reasons, or payloads.
				response = await deps.send(webhookUrl, { text });
			} catch {
				// deps.send threw — network error or timeout. Do NOT include any
				// URL fragment (which is the secret) in the reason.
				return { ok: false, reason: "send error" };
			}

			if (response.ok) {
				return { ok: true };
			}

			// Return the HTTP status code only — never the URL.
			return { ok: false, reason: `http ${response.status}` };
		},
	};
}
