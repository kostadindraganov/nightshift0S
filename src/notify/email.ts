/**
 * WHY: Email Channel for the Notifier fan-out (BLUEPRINT §3.10 item 4).
 * Fully injected transport (no nodemailer dep) so the module compiles and
 * tests cleanly on macOS with zero network. Mirrors the Telegram/Slack
 * fail-closed discipline:
 *
 *   - FAIL-CLOSED: if deps.to is missing, return
 *     { ok: false, reason: "unconfigured" } without calling deps.send.
 *   - Maps NotifyMessage → { to, subject: title, text: body }.
 *   - No secrets in this module — the transport (deps.send) owns credentials.
 */

import type { Channel, NotifyMessage } from "./notifier.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal email send abstraction. The production adapter wraps an SMTP client
 * (e.g. nodemailer) or a transactional email API. Tests pass a fake.
 * This is the ONLY network seam in this module.
 */
export type EmailSend = (msg: {
	to: string;
	subject: string;
	text: string;
}) => Promise<{ ok: boolean; detail?: string }>;

export interface EmailDeps {
	/** Destination address. undefined = unconfigured (fail-closed). */
	to: string | undefined;
	/** Optional sender address (e.g. "Nightshift <noreply@example.com>"). */
	from?: string;
	/** Injectable email transport — production wraps SMTP; tests pass a fake. */
	send: EmailSend;
}

// ---------------------------------------------------------------------------
// makeEmailChannel
// ---------------------------------------------------------------------------

/**
 * Build an email Channel. Returns a Channel whose send():
 *   - Returns { ok: false, reason: "unconfigured" } immediately when deps.to
 *     is missing — no send call made.
 *   - Otherwise maps NotifyMessage to { to, subject: msg.title, text: msg.body }
 *     and delegates to deps.send.
 *   - Maps the send result: ok=true iff deps.send returns { ok: true }.
 *   - On deps.send throw, returns { ok: false, reason: "send error" }.
 */
export function makeEmailChannel(deps: EmailDeps): Channel {
	return {
		name: "email",

		async send(msg: NotifyMessage): Promise<{ ok: boolean; reason?: string }> {
			// FAIL-CLOSED: no send call when unconfigured.
			if (!deps.to) {
				return { ok: false, reason: "unconfigured" };
			}

			let result: { ok: boolean; detail?: string };
			try {
				result = await deps.send({
					to: deps.to,
					subject: msg.title,
					text: msg.body,
				});
			} catch {
				return { ok: false, reason: "send error" };
			}

			if (result.ok) {
				return { ok: true };
			}

			// Include the transport's detail only when present (it must not be a
			// secret — transport authors are responsible for not leaking credentials
			// in detail). Truncate to avoid bloated reason strings.
			const detail = result.detail ? `: ${result.detail.slice(0, 120)}` : "";
			return { ok: false, reason: `email error${detail}` };
		},
	};
}
