/**
 * Declarative route table — the single source of truth for the HTTP API
 * (task 1.4). Every endpoint is one entry `{ method, path, auth, summary,
 * handler }`; `routeList()` derives the openapi-ish JSON description from
 * the SAME array and `GET /routes` serves it, so the docs can never drift
 * from the code.
 *
 * Path patterns support simple params: a `:name` segment matches any single
 * path segment and is exposed to the handler via `ctx.params`. Matching is
 * exact-segment otherwise — no wildcards, no trailing-slash tricks.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbHandle } from "../db/client.ts";

export interface RouteContext {
	req: Request;
	url: URL;
	/** Captured `:name` path params, URL-decoded. */
	params: Record<string, string>;
	handle: DbHandle;
}

export interface Route {
	method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	path: string;
	auth: boolean;
	summary: string;
	handler: (ctx: RouteContext) => Response | Promise<Response>;
}

/** JSON response helper — every body in the API is JSON. */
export function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

/** The one error envelope: `{ error: { code, message } }`. */
export function jsonError(status: number, code: string, message: string): Response {
	return Response.json({ error: { code, message } }, { status });
}

// ---------------------------------------------------------------------------
// Matching

export type RouteMatch =
	| { kind: "match"; route: Route; params: Record<string, string> }
	| { kind: "method_mismatch" }
	| { kind: "no_match" };

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
	const patternSegs = pattern.split("/").filter(Boolean);
	const pathSegs = pathname.split("/").filter(Boolean);
	if (patternSegs.length !== pathSegs.length) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < patternSegs.length; i++) {
		const p = patternSegs[i]!;
		const s = pathSegs[i]!;
		if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(s);
		else if (p !== s) return null;
	}
	return params;
}

/**
 * Resolve `method pathname` against a route table. Distinguishes "no route
 * at this path" (→ 404) from "path exists but not for this method" (→ 405)
 * so the server can answer correctly.
 */
export function matchRoute(table: Route[], method: string, pathname: string): RouteMatch {
	let pathExists = false;
	for (const route of table) {
		const params = matchPath(route.path, pathname);
		if (params === null) continue;
		pathExists = true;
		if (route.method === method) return { kind: "match", route, params };
	}
	return pathExists ? { kind: "method_mismatch" } : { kind: "no_match" };
}

// ---------------------------------------------------------------------------
// Version info (GET /version)

interface VersionInfo {
	name: string;
	version: string;
	commit?: string;
}

const REPO_ROOT = join(import.meta.dir, "../..");
let cachedVersion: VersionInfo | undefined;

/** Resolve HEAD via plain file reads — no subprocess. Omitted when unknown. */
function gitSha(): string | undefined {
	try {
		const head = readFileSync(join(REPO_ROOT, ".git/HEAD"), "utf8").trim();
		if (!head.startsWith("ref: ")) return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
		const sha = readFileSync(join(REPO_ROOT, ".git", head.slice("ref: ".length)), "utf8").trim();
		return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
	} catch {
		return undefined;
	}
}

function versionInfo(): VersionInfo {
	if (!cachedVersion) {
		const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
			name: string;
			version: string;
		};
		const commit = gitSha();
		cachedVersion = { name: pkg.name, version: pkg.version, ...(commit ? { commit } : {}) };
	}
	return cachedVersion;
}

// ---------------------------------------------------------------------------
// The table

export const routes: Route[] = [
	{
		method: "GET",
		path: "/healthz",
		auth: false,
		summary: "Liveness probe — 200 whenever the process is serving",
		handler: () => json({ ok: true }),
	},
	{
		method: "GET",
		path: "/readyz",
		auth: false,
		summary: "Readiness probe — 200 only when the DB is open and migrated",
		handler: (ctx) => {
			try {
				// One query proves both: the connection answers AND the drizzle
				// migrations journal exists with at least one applied entry.
				const row = ctx.handle.sqlite
					.query<{ n: number }, []>("SELECT count(*) AS n FROM __drizzle_migrations")
					.get();
				if (row && row.n > 0) return json({ ok: true });
			} catch {
				// fall through to 503
			}
			return jsonError(503, "not_ready", "database is not open or migrations have not applied");
		},
	},
	{
		method: "GET",
		path: "/version",
		auth: false,
		summary: "Service name, version, and git commit (when resolvable)",
		handler: () => json(versionInfo()),
	},
	{
		method: "GET",
		path: "/routes",
		auth: true,
		summary: "Describe the API: every route's method, path, auth flag, and summary",
		handler: () => json(routeList()),
	},
];

/** Openapi-ish description generated FROM the table — never hand-written. */
export function routeList(): Array<Pick<Route, "method" | "path" | "auth" | "summary">> {
	return routes.map(({ method, path, auth, summary }) => ({ method, path, auth, summary }));
}
