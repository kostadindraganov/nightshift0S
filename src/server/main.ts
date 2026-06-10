/**
 * HTTP server wiring (task 1.4): Bun.serve over the declarative route table
 * in `routes.ts`. `createServer()` is a factory so tests can boot on port 0
 * with a :memory: DB; running this file directly (`bun run dev`) opens the
 * real DB, applies migrations, and listens on NIGHTSHIFT_PORT (default 3000).
 *
 * Every non-2xx body uses the JSON envelope `{ error: { code, message } }`:
 * 404 unknown path, 405 wrong method on a known path, 401 bad/missing token,
 * 503 auth unconfigured or not ready, 500 handler crash.
 */

import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { authenticate } from "./auth.ts";
import { jsonError, matchRoute, routes, type RouteContext } from "./routes.ts";

export const DEFAULT_PORT = 3000;

export interface CreateServerOptions {
	/** Listen port; 0 lets the OS pick (tests). Default: NIGHTSHIFT_PORT or 3000. */
	port?: number;
	/** DB path passed to openDatabase; default NIGHTSHIFT_DB_PATH or data/nightshift.db. */
	dbPath?: string;
}

export function createServer(options: CreateServerOptions = {}): Bun.Server<undefined> {
	const port = options.port ?? Number(process.env.NIGHTSHIFT_PORT ?? DEFAULT_PORT);
	// Open + migrate before serving so /readyz is honest from the first request.
	const handle = openDatabase(options.dbPath);
	runMigrations(handle);

	return Bun.serve({
		port,
		async fetch(req) {
			const url = new URL(req.url);
			const match = matchRoute(routes, req.method, url.pathname);
			if (match.kind === "no_match") {
				return jsonError(404, "not_found", `no route for ${url.pathname}`);
			}
			if (match.kind === "method_mismatch") {
				return jsonError(405, "method_not_allowed", `${req.method} not allowed for ${url.pathname}`);
			}
			if (match.route.auth) {
				const auth = authenticate(req);
				if (!auth.ok) return jsonError(auth.status, auth.code, auth.message);
			}
			const ctx: RouteContext = { req, url, params: match.params, handle };
			try {
				return await match.route.handler(ctx);
			} catch (err) {
				return jsonError(500, "internal_error", err instanceof Error ? err.message : String(err));
			}
		},
	});
}

if (import.meta.main) {
	const server = createServer();
	console.log(`nightshift listening on ${server.url}`);
}
