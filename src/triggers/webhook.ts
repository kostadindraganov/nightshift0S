/**
 * WHY: Webhook ingress for the trigger system (BLUEPRINT §3.2, §3.10 item 3,
 * §3.12.6). External callers (GitHub, CI, etc.) POST to /webhooks/:triggerId
 * with an HMAC-SHA256 signature; the signature IS the auth — no bearer token.
 *
 * Two public surfaces:
 *   - verifyWebhookSignature: pure HMAC check, constant-time, fail-closed.
 *   - processWebhook: the full ingress gauntlet — load trigger, check kind,
 *     parse authz, verify signature, dedupe, rate-limit, then delegate to
 *     fireTrigger which honours dry_run_default.
 *
 * Secret hygiene (§3.12.7): the secret value is NEVER placed in any returned
 * reason, event payload, or log. The signature is never echoed. The authz_json
 * blob (which may carry a secret ref) is never forwarded to the caller.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import { getTrigger } from "./triggers.ts";
import { fireTrigger } from "./triggers.ts";
import { events } from "../db/schema.ts";
import { and, eq, gt } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProcessWebhookDeps {
	handle: DbHandle;
	log: EventLog;
}

export interface ProcessWebhookInput {
	rawBody: string;
	signature: string | null;
	deliveryId?: string;
}

export type ProcessWebhookResult =
	| { ok: true; taskId: number }
	| { ok: false; reason: string; status: number };

/** Parsed shape of authz_json for webhook triggers. */
interface WebhookAuthzConfig {
	/** The HMAC secret value (test-injected directly) or a keyring ref. */
	secret?: string;
	/** The keyring ref form; production resolves this; tests use `secret`. */
	secretRef?: string;
	/** Allowlist of actor identities allowed to fire through fireTrigger. */
	allowlist?: string[];
	/** Max fires per hour before rate_limited. */
	rateLimitPerHour?: number;
	/** Dedupe window in seconds. */
	dedupeWindowSeconds?: number;
}

// ---------------------------------------------------------------------------
// verifyWebhookSignature
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA256 of rawBody keyed by secret, constant-time compared against the
 * provided signature. Accepts "sha256=<hex>" or plain "<hex>". Returns false on
 * any missing, too-short, or mismatched value — never throws.
 */
export function verifyWebhookSignature(
	secret: string,
	rawBody: string,
	signature: string | null,
): boolean {
	if (signature === null || signature.length === 0) return false;

	// Strip optional "sha256=" prefix (GitHub-style).
	const hexSig = signature.startsWith("sha256=") ? signature.slice(7) : signature;

	// Must be a valid 64-char hex string (32-byte SHA256).
	if (hexSig.length !== 64) return false;

	let sigBuf: Buffer;
	try {
		sigBuf = Buffer.from(hexSig, "hex");
	} catch {
		return false;
	}
	if (sigBuf.length !== 32) return false;

	const expected = createHmac("sha256", secret).update(rawBody).digest();

	try {
		return timingSafeEqual(expected, sigBuf);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TRIGGER_FIRED = "trigger.fired";

/** Reason → HTTP status map for processWebhook (mirrors triggerRoutes). */
function reasonToStatus(reason: string): number {
	if (reason === "not_found") return 404;
	if (reason === "authz_denied") return 403;
	if (reason === "bad_signature") return 401;
	if (reason === "duplicate") return 409;
	if (reason === "rate_limited") return 429;
	if (reason === "dry_run_pending") return 409;
	return 400;
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
// processWebhook
// ---------------------------------------------------------------------------

/**
 * Full webhook ingress gauntlet. Fail-closed in order:
 *   1. load trigger            -> not_found/404
 *   2. kind === "webhook"      -> wrong_kind/400
 *   3. parse authz_json        -> bad_signature/401 on corrupt config (fail-closed)
 *   4. verify HMAC signature   -> bad_signature/401
 *   5. dedupe by deliveryId    -> duplicate/409
 *   6. rate limit              -> rate_limited/429
 *   7. delegate to fireTrigger -> honours dry_run_default, maps reasons to statuses
 *
 * The secret is read from authz_json.secret (tests inject it directly) or
 * authz_json.secretRef (production keyring ref — currently treated as the
 * secret value for hermeticity in this implementation; a real keyring resolver
 * would be injected via Deps when integrated). NEVER logged or returned.
 */
export async function processWebhook(
	deps: ProcessWebhookDeps,
	triggerId: number,
	input: ProcessWebhookInput,
): Promise<ProcessWebhookResult> {
	const { handle, log } = deps;
	const { rawBody, signature, deliveryId } = input;

	// 1. Load trigger.
	const trigger = getTrigger(handle, triggerId);
	if (trigger === null) return { ok: false, reason: "not_found", status: 404 };

	// 2. Kind check.
	if (trigger.kind !== "webhook") {
		return { ok: false, reason: "wrong_kind", status: 400 };
	}

	// 3. Parse authz config — fail-closed on corrupt JSON (same as fireTrigger).
	let authz: WebhookAuthzConfig;
	try {
		const raw = trigger.authzJson;
		if (raw === null || raw === "") {
			authz = {};
		} else {
			const parsed = JSON.parse(raw) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				// Corrupt blob → deny (don't expose what went wrong).
				return { ok: false, reason: "bad_signature", status: 401 };
			}
			authz = parsed as WebhookAuthzConfig;
		}
	} catch {
		return { ok: false, reason: "bad_signature", status: 401 };
	}

	// 4. Verify HMAC signature.
	//    Secret resolution: tests inject authz_json.secret directly; production
	//    would resolve authz_json.secretRef from a keyring. We treat secretRef
	//    as the literal secret value here for hermeticity (no keyring dep).
	const secret = authz.secret ?? authz.secretRef ?? null;
	// If no secret is configured the signature check always fails (fail-closed).
	const secretValue = secret ?? "";
	if (!secret || !verifyWebhookSignature(secretValue, rawBody, signature)) {
		// NEVER include secret/signature value in the reason.
		return { ok: false, reason: "bad_signature", status: 401 };
	}

	const now = Date.now();

	// 5. Dedupe by deliveryId within dedupeWindowSeconds.
	if (
		deliveryId !== undefined &&
		deliveryId.length > 0 &&
		authz.dedupeWindowSeconds !== undefined &&
		authz.dedupeWindowSeconds > 0
	) {
		const windowStart = now - authz.dedupeWindowSeconds * 1000;
		const dup = recentFiredEvents(handle, triggerId, windowStart).some((e) => {
			try {
				const p = JSON.parse(e.payloadJson) as { dedupeKey?: unknown };
				return p.dedupeKey === deliveryId;
			} catch {
				return false;
			}
		});
		if (dup) return { ok: false, reason: "duplicate", status: 409 };
	}

	// 6. Rate limit.
	if (authz.rateLimitPerHour !== undefined && authz.rateLimitPerHour >= 0) {
		const hourAgo = now - 3_600_000;
		const firedLastHour = recentFiredEvents(handle, triggerId, hourAgo).length;
		if (firedLastHour >= authz.rateLimitPerHour) {
			return { ok: false, reason: "rate_limited", status: 429 };
		}
	}

	// 7. Delegate to fireTrigger — it runs its own authz/dedupe/rate/dry-run
	//    gates internally. We pass actor="webhook" (the caller identity) and
	//    dedupeKey=deliveryId so fireTrigger stamps it in the event for deduping.
	//    The allowlist in authz must include "webhook" for fireTrigger to pass
	//    the authz gate; tests must configure this.
	const result = await fireTrigger({ handle, log }, triggerId, {
		actor: "webhook",
		source: "webhook",
		...(deliveryId !== undefined && deliveryId.length > 0 ? { dedupeKey: deliveryId } : {}),
	});

	if (!result.ok) {
		return { ok: false, reason: result.reason, status: reasonToStatus(result.reason) };
	}
	return { ok: true, taskId: result.taskId };
}
