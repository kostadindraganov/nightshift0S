/**
 * WHY: Every payload entering the append-only thread MUST be scrubbed of
 * credentials BEFORE it is persisted (BLUEPRINT §3.12.28 — the unredacted
 * value never reaches an INSERT). We reuse the forge secret-scanner's exact
 * pattern set (SECRET_RULES) so "what blocks a push" and "what gets redacted
 * in the thread" can never drift apart. This is a pure, side-effect-free deep
 * walk: non-strings pass through untouched; matched secret substrings are
 * replaced with `[REDACTED:<rule.name>]` so the audit trail still shows WHICH
 * kind of secret was scrubbed without leaking the value.
 */

import { SECRET_RULES } from "../forge/secretScan.ts";

export interface RedactResult {
	redacted: boolean;
	value: unknown;
}

/**
 * Private-key BLOCK matcher (redaction-only). secretScan's `private-key-header`
 * rule deliberately matches just the `-----BEGIN ... PRIVATE KEY-----` header
 * (detecting the header is enough to BLOCK a push). Redaction's contract is to
 * strip the secret VALUE — and the key VALUE is the base64 body, not the header
 * — so here we scrub the whole block from BEGIN through END. The divergence is
 * intentional: detect-to-block vs strip-the-value.
 */
const PRIVATE_KEY_BLOCK =
	/-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g;

/**
 * Scan a single string against every SECRET_RULES pattern (re-compiled with the
 * `g` flag so all occurrences are caught) and replace each matched secret with
 * a `[REDACTED:<rule.name>]` marker. The secret substring is the rule's
 * `extract()`ed group when present (skipped when extract returns ""), otherwise
 * the full match. Returns the (possibly) rewritten string and whether anything
 * was redacted.
 */
function redactString(input: string): { redacted: boolean; value: string } {
	let value = input;
	let redacted = false;

	// Scrub multi-line private-key BLOCKS (header + base64 body + footer) FIRST,
	// before the header-only rule below can leave the body behind. Marker name
	// matches secretScan's header rule so the audit trail is consistent.
	if (PRIVATE_KEY_BLOCK.test(value)) {
		value = value.replace(PRIVATE_KEY_BLOCK, "[REDACTED:private-key-header]");
		redacted = true;
	}

	for (const rule of SECRET_RULES) {
		// Re-compile with the global flag so every occurrence is scanned; the
		// rule's own flags (e.g. `i`) are preserved.
		const flags = rule.pattern.flags.includes("g")
			? rule.pattern.flags
			: rule.pattern.flags + "g";
		const re = new RegExp(rule.pattern.source, flags);

		// Collect the distinct secret substrings first, then replace — replacing
		// inside the loop would shift indices and confuse the stateful regex.
		const secrets = new Set<string>();
		for (const m of value.matchAll(re)) {
			const secret = rule.extract ? rule.extract(m) : (m[0] ?? "");
			if (secret) secrets.add(secret);
		}

		for (const secret of secrets) {
			// String#replaceAll on a literal substring — no regex metachar risk.
			value = value.split(secret).join(`[REDACTED:${rule.name}]`);
			redacted = true;
		}
	}

	return { redacted, value };
}

/**
 * Deep-walk a JSON-serializable value. Every string is scanned with the secret
 * rules; objects and arrays are rebuilt with redacted children. Non-strings
 * (numbers, booleans, null) pass through unchanged. `redacted` is true if ANY
 * string anywhere in the structure was rewritten.
 */
export function redactPayload(value: unknown): RedactResult {
	if (typeof value === "string") {
		const r = redactString(value);
		return { redacted: r.redacted, value: r.value };
	}

	if (Array.isArray(value)) {
		let redacted = false;
		const out = value.map((item) => {
			const r = redactPayload(item);
			if (r.redacted) redacted = true;
			return r.value;
		});
		return { redacted, value: out };
	}

	if (value !== null && typeof value === "object") {
		let redacted = false;
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			const r = redactPayload(v);
			if (r.redacted) redacted = true;
			out[k] = r.value;
		}
		return { redacted, value: out };
	}

	return { redacted: false, value };
}
