/**
 * WHY: Telegram chat-trigger ingress (BLUEPRINT §3.2, §3.10 item 3, §3.12.6).
 * Telegram delivers updates by POSTing to a webhook URL; an optional secret
 * token in "x-telegram-bot-api-secret-token" IS the authentication mechanism —
 * no bearer token. The authz_json for a "chat" trigger carries:
 *   { secretToken?, allowChatIds?, allowUsernames?, rateLimitPerHour?,
 *     dedupeWindowSeconds? }
 *
 * Fail-closed gauntlet (in order):
 *   1. load trigger          -> not_found/404
 *   2. kind === "chat"       -> wrong_kind/400
 *   3. parse authz_json      -> bad_token/401 on corrupt config
 *   4. verify secret token   -> bad_token/401 (constant-time-ish compare)
 *   5. allowlist check       -> authz_denied/403
 *   6. dedupe by update_id   -> duplicate/409
 *   7. rate limit            -> rate_limited/429
 *   8. delegate to fireTrigger (honours dry_run_default -> dry_run_pending)
 *
 * SECRET HYGIENE (§3.12.7): the secretToken value is NEVER placed in any
 * returned reason string, event payload, or log. Reasons carry only symbolic
 * codes so a caller cannot exfiltrate the configured token via error messages.
 */

import { timingSafeEqual } from "node:crypto";
import type { DbHandle } from "../db/client.ts";
import { events } from "../db/schema.ts";
import { and, eq, gt } from "drizzle-orm";
import type { EventLog } from "../events/events.ts";
import { getTrigger, fireTrigger } from "./triggers.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TelegramUpdate {
	update_id: number;
	message?: {
		chat: { id: number };
		from?: { id: number; username?: string };
		text?: string;
	};
}

export interface ProcessChatInput {
	update: TelegramUpdate;
	/** Value from "x-telegram-bot-api-secret-token" header; null when absent. */
	secretToken: string | null;
}

export type ProcessChatResult =
	| { ok: true; taskId: number }
	| { ok: false; reason: string; status: number };

/** Parsed shape of authz_json for chat triggers. */
interface ChatAuthzConfig {
	/** The expected Telegram secret token. When absent, all tokens are denied (fail-closed). */
	secretToken?: string;
	/** Allowlisted numeric chat IDs. When absent or empty, all chats are denied. */
	allowChatIds?: number[];
	/** Allowlisted Telegram usernames (without the @). When absent or empty, blocks by username. */
	allowUsernames?: string[];
	/** Max fires per hour before rate_limited. */
	rateLimitPerHour?: number;
	/** Dedupe window in seconds for update_id deduplication. */
	dedupeWindowSeconds?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TRIGGER_FIRED = "trigger.fired";

/**
 * Constant-time-ish string comparison (token vs expected).
 * Uses timingSafeEqual on Buffer pairs; returns false on any mismatch of length
 * or null inputs. "ish" because a length difference is still observable —
 * fully timing-safe comparison requires equal-length inputs.
 */
function safeCompareTokens(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	try {
		const aBuf = Buffer.from(a, "utf8");
		const bBuf = Buffer.from(b, "utf8");
		return timingSafeEqual(aBuf, bBuf);
	} catch {
		return false;
	}
}

/** Recent trigger.fired events for this trigger (direct read under WAL). */
function recentFiredEvents(handle: DbHandle, triggerId: number, sinceMs: number) {
	const sinceIso = new Date(sinceMs).toISOString();
	return handle.db
		.select()
		.from(events)
		.where(and(eq(events.kind, TRIGGER_FIRED), gt(events.ts, sinceIso)))
		.all()
		.filter((e) => {
			try {
				const p = JSON.parse(e.payloadJson) as { triggerId?: unknown };
				return p.triggerId === triggerId;
			} catch {
				return false;
			}
		});
}

// ---------------------------------------------------------------------------
// processChatUpdate — the dispatch gauntlet
// ---------------------------------------------------------------------------

/**
 * Full chat-trigger ingress gauntlet. Fail-closed in order — see module WHY
 * for the full gate list. The secretToken is consumed here but NEVER forwarded
 * to the caller in any reason string or event payload.
 */
export async function processChatUpdate(
	deps: { handle: DbHandle; log: EventLog },
	triggerId: number,
	input: ProcessChatInput,
): Promise<ProcessChatResult> {
	const { handle, log } = deps;
	const { update, secretToken } = input;
	const { update_id, message } = update;

	// 1. Load trigger.
	const trigger = getTrigger(handle, triggerId);
	if (trigger === null) return { ok: false, reason: "not_found", status: 404 };

	// 2. Kind check.
	if (trigger.kind !== "chat") {
		return { ok: false, reason: "wrong_kind", status: 400 };
	}

	// 3. Parse authz_json — fail-closed on corrupt JSON.
	let authz: ChatAuthzConfig;
	try {
		const raw = trigger.authzJson;
		if (raw === null || raw === "") {
			authz = {};
		} else {
			const parsed = JSON.parse(raw) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				// Corrupt config → deny without revealing anything.
				return { ok: false, reason: "bad_token", status: 401 };
			}
			authz = parsed as ChatAuthzConfig;
		}
	} catch {
		return { ok: false, reason: "bad_token", status: 401 };
	}

	// 4. Verify secret token (constant-time-ish).
	//    If no secretToken is configured, all requests are denied (fail-closed).
	//    The configured token MUST NOT appear in the returned reason.
	const configuredToken = authz.secretToken ?? null;
	if (configuredToken === null || configuredToken === "") {
		// No secret configured → deny to prevent open webhooks.
		return { ok: false, reason: "bad_token", status: 401 };
	}
	const providedToken = secretToken ?? "";
	if (!safeCompareTokens(providedToken, configuredToken)) {
		return { ok: false, reason: "bad_token", status: 401 };
	}

	// 5. Allowlist check: the message's chat.id / from.username must be allowed.
	//    Empty or absent allowChatIds + allowUsernames → deny (fail-closed).
	const chatId = message?.chat.id;
	const username = message?.from?.username;

	const allowChatIds = authz.allowChatIds ?? [];
	const allowUsernames = authz.allowUsernames ?? [];

	const chatAllowed = chatId !== undefined && allowChatIds.includes(chatId);
	const userAllowed = username !== undefined && allowUsernames.includes(username);

	if (!chatAllowed && !userAllowed) {
		return { ok: false, reason: "authz_denied", status: 403 };
	}

	const now = Date.now();

	// 6. Dedupe by update_id within dedupeWindowSeconds.
	if (authz.dedupeWindowSeconds !== undefined && authz.dedupeWindowSeconds > 0) {
		const windowStart = now - authz.dedupeWindowSeconds * 1000;
		const dedupeKey = String(update_id);
		const dup = recentFiredEvents(handle, triggerId, windowStart).some((e) => {
			try {
				const p = JSON.parse(e.payloadJson) as { dedupeKey?: unknown };
				return p.dedupeKey === dedupeKey;
			} catch {
				return false;
			}
		});
		if (dup) return { ok: false, reason: "duplicate", status: 409 };
	}

	// 7. Rate limit.
	if (authz.rateLimitPerHour !== undefined && authz.rateLimitPerHour >= 0) {
		const hourAgo = now - 3_600_000;
		const firedLastHour = recentFiredEvents(handle, triggerId, hourAgo).length;
		if (firedLastHour >= authz.rateLimitPerHour) {
			return { ok: false, reason: "rate_limited", status: 429 };
		}
	}

	// 8. Delegate to fireTrigger — it runs the authz/dedupe/rate/dry-run gates
	//    internally. Actor encodes the identity; source="chat" so the
	//    EXTERNAL_SOURCES gate in fireTrigger applies. The allowlist in authz_json
	//    must include the actor string for fireTrigger to pass its own authz gate.
	const actor = `chat:${username ?? String(chatId ?? update_id)}`;
	const result = await fireTrigger({ handle, log }, triggerId, {
		actor,
		source: "chat",
		dedupeKey: String(update_id),
	});

	if (!result.ok) {
		// Map fireTrigger reason codes to HTTP statuses.
		const status = reasonToStatus(result.reason);
		return { ok: false, reason: result.reason, status };
	}
	return { ok: true, taskId: result.taskId };
}

/** Reason → HTTP status for downstream errors from fireTrigger. */
function reasonToStatus(reason: string): number {
	if (reason === "not_found") return 404;
	if (reason === "authz_denied") return 403;
	if (reason === "bad_token") return 401;
	if (reason === "duplicate") return 409;
	if (reason === "rate_limited") return 429;
	if (reason === "dry_run_pending") return 409;
	return 400;
}
