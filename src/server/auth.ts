/**
 * Bearer-token auth for the HTTP API (task 1.4).
 *
 * WHY hash-then-compare: `timingSafeEqual` throws when the inputs differ in
 * length, and even catching that throw leaks whether the presented token has
 * the right length. Hashing both sides with SHA-256 first yields two
 * equal-length digests, so the comparison is constant-time regardless of
 * what the caller sent.
 *
 * WHY fail closed: if NIGHTSHIFT_API_TOKEN is unset there is nothing to
 * authenticate against, so every auth-required route returns 503 — the
 * server never silently runs open. The env var is read per request (not
 * cached at boot) so tests and operators see the live value.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export type AuthResult =
	| { ok: true }
	| { ok: false; status: 401 | 503; code: string; message: string };

const BEARER_PREFIX = "Bearer ";

function sha256(input: string): Buffer {
	return createHash("sha256").update(input).digest();
}

/** Validate the Authorization header of `req` against NIGHTSHIFT_API_TOKEN. */
export function authenticate(req: Request): AuthResult {
	const expected = process.env.NIGHTSHIFT_API_TOKEN;
	if (!expected) {
		return {
			ok: false,
			status: 503,
			code: "auth_not_configured",
			message: "NIGHTSHIFT_API_TOKEN is not set; authenticated routes are disabled (fail closed)",
		};
	}
	const header = req.headers.get("authorization");
	if (!header || !header.startsWith(BEARER_PREFIX)) {
		return { ok: false, status: 401, code: "unauthorized", message: "missing bearer token" };
	}
	const presented = header.slice(BEARER_PREFIX.length);
	if (!timingSafeEqual(sha256(presented), sha256(expected))) {
		return { ok: false, status: 401, code: "unauthorized", message: "invalid bearer token" };
	}
	return { ok: true };
}
