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

import index from "../../web/index.html";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { EventLog } from "../events/events.ts";
import { ValidationError } from "../tasks/tasks.ts";
import { authenticate } from "./auth.ts";
import { jsonError, matchRoute, routes, type RouteContext } from "./routes.ts";
import { startSchedulerLoop } from "../scheduler/loop.ts";
import {
	makeTermWebsocket,
	matchTermPath,
	handleTermUpgrade,
	type TermSocketData,
} from "./terminalRoutes.ts";

export const DEFAULT_PORT = 3000;

export interface CreateServerOptions {
	/** Listen port; 0 lets the OS pick (tests). Default: NIGHTSHIFT_PORT or 3000. */
	port?: number;
	/** DB path passed to openDatabase; default NIGHTSHIFT_DB_PATH or data/nightshift.db. */
	dbPath?: string;
	/** When true, enables Bun HMR + console forwarding for the bundled SPA. */
	dev?: boolean;
}

export function createServer(options: CreateServerOptions = {}): Bun.Server<TermSocketData> {
	const port = options.port ?? Number(process.env.NIGHTSHIFT_PORT ?? DEFAULT_PORT);
	// Open + migrate before serving so /readyz is honest from the first request.
	const handle = openDatabase(options.dbPath);
	runMigrations(handle);
	// One event log per server — the write-through emitter AND the SSE source.
	const events = new EventLog(handle);

	return Bun.serve<TermSocketData>({
		port,
		// Serve the bundled React SPA at /; the fetch handler covers all API paths.
		routes: { "/": index },
		// Must exceed the SSE heartbeat interval (15s) or Bun would reset idle
		// event-stream connections between heartbeats (default is 10s).
		idleTimeout: 60,
		// Read-only xterm attach to a run's tmux pane (LIVE-WIRING D4). The
		// handler is server-level; the fetch handler does the upgrade below.
		websocket: makeTermWebsocket(handle),
		...(options.dev ? { development: { hmr: true, console: true } } : {}),
		async fetch(req, server) {
			const url = new URL(req.url);
			// WebSocket terminal attach (D4): handled BEFORE matchRoute. On upgrade
			// Bun owns the socket and fetch returns undefined; a refusal Response is
			// returned as-is (503 auth unset / 401 bad token / 404 / 409 no session).
			const termId = matchTermPath(url.pathname);
			if (termId !== null && req.method === "GET") {
				const refusal = handleTermUpgrade(server, req, url, handle);
				if (refusal !== undefined) return refusal;
				return undefined as never; // upgraded — Bun owns the socket now.
			}
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
			const ctx: RouteContext = { req, url, params: match.params, handle, events };
			try {
				return await match.route.handler(ctx);
			} catch (err) {
				if (err instanceof ValidationError) {
					const code =
						err.status === 404 ? "not_found" : err.status === 409 ? "conflict" : "invalid_request";
					return jsonError(err.status, code, err.message);
				}
				return jsonError(500, "internal_error", err instanceof Error ? err.message : String(err));
			}
		},
	});
}

if (import.meta.main) {
	const server = createServer({ dev: true });
	console.log(`nightshift listening on ${server.url}`);

	// Unattended overnight loop (PHASE5A-CONTRACT §8). GUARDED: started ONLY on
	// the `bun run dev` path, NEVER inside createServer() — the test suite boots
	// createServer with a :memory: DB and no loop, so no scheduler timer, tmux
	// session, or egress probe ever runs during tests.
	//
	// The host-specific routing/transcript/activity closures (resolveSpawn,
	// readTranscriptTail, runActivity) are operator-owned (same pattern as
	// prodDeps.ts's resolveRepo): only the host knows how a project's repoUrl
	// maps to a local checkout and which prompt to build. Until those are wired
	// for this deployment, the loop is composed but its resolveSpawn fail-closes
	// (returns null → every task is skipped, no pretend spawn). Wire them here:
	//
	//   const { handle, events, config } = /* from createServer internals */;
	//   const loop = await startSchedulerLoop({
	//     handle, log: events, config,
	//     resolveSpawn: hostRoutingClosure,        // §5.1 + §3.12.18 reassign hint
	//     readTranscriptTail: liveTranscriptReader,
	//     runActivity: hostActivityTracker,
	//   });
	//   process.on("SIGTERM", () => loop.stop());
	//
	// Left unwired this wave per the contract's macOS-fakes scope; the live
	// tmux+egress+bwrap loop is exercised on the Linux VM (GATE 5). The
	// `startSchedulerLoop` import below documents the call site and keeps it
	// type-checked.
	void startSchedulerLoop;
}
