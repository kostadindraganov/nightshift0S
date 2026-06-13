/**
 * WHY: HTTP surface for inbound Telegram chat-trigger updates (BLUEPRINT §3.2,
 * §3.10 item 3, §3.12.6). Telegram POSTs updates to this endpoint. auth:false
 * at the bearer layer — the secret token in "x-telegram-bot-api-secret-token"
 * IS the authentication mechanism; processChatUpdate handles that gate.
 *
 * Thin wrapper over processChatUpdate: parse the JSON body as a TelegramUpdate,
 * extract the secret-token header, call processChatUpdate, and map the result
 * onto an HTTP response. The orchestrator (src/server/routes.ts) spreads
 * `chatRoutes` into the table; this module MUST NOT edit that file.
 */

import type { Route, RouteContext } from "../server/routes.ts";
import { json, jsonError } from "../server/routes.ts";
import { processChatUpdate, type TelegramUpdate } from "./chat.ts";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleChatUpdate(ctx: RouteContext): Promise<Response> {
	const rawTriggerId = ctx.params.triggerId;
	const triggerId = rawTriggerId === undefined ? NaN : Number(rawTriggerId);
	if (!Number.isInteger(triggerId) || triggerId <= 0) {
		return jsonError(400, "invalid_input", "triggerId must be a positive integer");
	}

	// Parse the JSON body as a TelegramUpdate.
	let update: TelegramUpdate;
	try {
		const body = await ctx.req.json();
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return jsonError(400, "invalid_input", "request body must be a JSON object");
		}
		update = body as TelegramUpdate;
	} catch {
		return jsonError(400, "invalid_input", "request body must be valid JSON");
	}

	// The Telegram secret token — the authentication mechanism for this endpoint.
	const secretToken = ctx.req.headers.get("x-telegram-bot-api-secret-token");

	const result = await processChatUpdate(
		{ handle: ctx.handle, log: ctx.events },
		triggerId,
		{ update, secretToken },
	);

	if (!result.ok) {
		// Map reason to a code; NEVER echo the secret token or raw authz config.
		const code =
			result.reason === "not_found" ? "not_found"
			: result.reason === "wrong_kind" ? "wrong_kind"
			: result.reason === "bad_token" ? "bad_token"
			: result.reason === "authz_denied" ? "authz_denied"
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

export const chatRoutes: Route[] = [
	{
		method: "POST",
		path: "/chat/telegram/:triggerId",
		// auth:false — external Telegram updates have no bearer token.
		// The "x-telegram-bot-api-secret-token" header is the auth mechanism.
		auth: false,
		summary:
			"Inbound Telegram update for a chat trigger: secret-token verified, allowlist checked, deduped, rate-limited → creates a backlog task",
		handler: handleChatUpdate,
	},
];
