/**
 * WHY: HTTP surface for inbound webhook deliveries (BLUEPRINT §3.2, §3.10
 * item 3, §3.12.6). External callers (GitHub, CI, etc.) POST to
 * /webhooks/:triggerId. auth:false at the bearer layer — the HMAC signature
 * in the "x-nightshift-signature" (or "x-hub-signature-256") header IS the
 * authentication mechanism.
 *
 * Thin wrapper over processWebhook — reads the raw body (text, not parsed),
 * extracts the signature and delivery-id headers, calls processWebhook, and
 * maps its result onto an HTTP response. No bearer auth — these arrive from
 * external systems that have no nightshift token.
 *
 * The orchestrator (src/server/routes.ts) spreads `webhookRoutes` into the
 * table; this module must NOT edit that file.
 */

import type { Route, RouteContext } from "../server/routes.ts";
import { json, jsonError } from "../server/routes.ts";
import { processWebhook } from "./webhook.ts";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleWebhookDelivery(ctx: RouteContext): Promise<Response> {
	const rawTriggerId = ctx.params.triggerId;
	const triggerId = rawTriggerId === undefined ? NaN : Number(rawTriggerId);
	if (!Number.isInteger(triggerId) || triggerId <= 0) {
		return jsonError(400, "invalid_input", "triggerId must be a positive integer");
	}

	// Read the raw body as text so HMAC can be computed over the exact bytes.
	let rawBody: string;
	try {
		rawBody = await ctx.req.text();
	} catch {
		return jsonError(400, "invalid_input", "could not read request body");
	}

	// Signature: prefer the nightshift header; fall back to GitHub's header.
	const signature =
		ctx.req.headers.get("x-nightshift-signature") ??
		ctx.req.headers.get("x-hub-signature-256");

	// Optional delivery ID for idempotency / deduplication.
	const deliveryId = ctx.req.headers.get("x-delivery-id") ?? undefined;

	const result = await processWebhook(
		{ handle: ctx.handle, log: ctx.events },
		triggerId,
		{ rawBody, signature, deliveryId },
	);

	if (!result.ok) {
		// Map the reason to a code; never include the raw signature or secret.
		const code =
			result.reason === "not_found" ? "not_found"
			: result.reason === "bad_signature" ? "bad_signature"
			: result.reason === "wrong_kind" ? "wrong_kind"
			: result.reason === "duplicate" ? "duplicate"
			: result.reason === "rate_limited" ? "rate_limited"
			: result.reason === "dry_run_pending" ? "dry_run_pending"
			: "invalid_input";
		return jsonError(result.status, code, result.reason);
	}

	return json({ ok: true, task_id: result.taskId }, 201);
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

export const webhookRoutes: Route[] = [
	{
		method: "POST",
		path: "/webhooks/:triggerId",
		// auth:false — external callers have no bearer token; HMAC is the auth.
		auth: false,
		summary:
			"Inbound webhook delivery for a trigger: HMAC-verified, deduped, rate-limited → creates a backlog task",
		handler: handleWebhookDelivery,
	},
];
