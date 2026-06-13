/**
 * WHY: Production HTTP + email transport implementations for the notifier
 * channels (BLUEPRINT §3.10 item 4). These are the two concrete "last-mile"
 * adapters that cross the network boundary at runtime:
 *
 *   fetchHttpSend    — wraps the global `fetch` so Telegram/Slack channels
 *                      can POST JSON without importing fetch themselves. A
 *                      network error is caught and returned as { ok:false,
 *                      status:0 } (fail-closed; no throw propagates).
 *
 *   unconfiguredEmailSend — the fail-closed default EmailSend used when no
 *                      real SMTP transport is provided by the host. Immediately
 *                      returns { ok:false, detail:"no_email_transport" }. A
 *                      host that wants live email injects its own EmailSend
 *                      (e.g. wrapping nodemailer, SendGrid, or SES); this
 *                      default keeps makeEmailChannel inert until then.
 *
 * SECURITY (BLUEPRINT §3.12.7): this module never logs URLs, tokens, or any
 * payload content. The url argument to fetchHttpSend may contain a secret
 * (Telegram bot token, Slack webhook URL) and must never appear in returned
 * reason strings or any log line.
 *
 * No new npm deps — global fetch is available in Bun 1+.
 */

import type { HttpSend } from "./telegram.ts";
import type { EmailSend } from "./email.ts";

// ---------------------------------------------------------------------------
// fetchHttpSend
// ---------------------------------------------------------------------------

/**
 * Production HttpSend adapter. POSTs `body` as JSON to `url` using the
 * global fetch. Returns { ok: res.ok, status: res.status } on any HTTP
 * response (including error status codes). On a network-level error (no
 * response at all), returns { ok: false, status: 0 } — never throws.
 *
 * SECURITY: the url may contain a bot token or webhook secret. It is used
 * only in the fetch call and MUST NOT be copied into any log or error string.
 */
export const fetchHttpSend: HttpSend = async (url, body) => {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return { ok: res.ok, status: res.status };
	} catch {
		// Network error (DNS failure, timeout, etc.) — fail-closed, status=0.
		return { ok: false, status: 0 };
	}
};

// ---------------------------------------------------------------------------
// unconfiguredEmailSend
// ---------------------------------------------------------------------------

/**
 * Fail-closed default EmailSend. Always returns { ok:false,
 * detail:"no_email_transport" } without attempting any network call.
 *
 * Used as the default transport in makeEmailChannel so the email channel
 * stays inert until the host injects a real EmailSend (e.g. wrapping
 * nodemailer, SendGrid, or Amazon SES). Adding a real SMTP dependency to
 * nightshift itself is a non-goal; the injection seam is the contract.
 *
 * A host wires a live transport like this:
 *
 *   import { makeEmailChannel } from "src/notify/email.ts";
 *   const ch = makeEmailChannel({ to: "ops@example.com", send: mySmtpSend });
 */
export const unconfiguredEmailSend: EmailSend = async () => ({
	ok: false,
	detail: "no_email_transport",
});
