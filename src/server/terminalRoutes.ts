/**
 * WHY: Read-only, bearer-authed WebSocket attach to a live coder run's tmux
 * pane (L4 of LIVE-WIRING-CONTRACT §D4). Browsers cannot set an Authorization
 * header on a WebSocket, so the bearer arrives as `?token=` and is compared
 * constant-time against NIGHTSHIFT_API_TOKEN — fail-closed: env unset ⇒ 503,
 * mismatch ⇒ 401. The attach is structurally read-only: this module has NO
 * send-keys / stdin path, so a malicious client can never type into the pane.
 *
 * tmux streaming uses `pipe-pane` (idempotent: `-o` replaces any prior pipe)
 * writing the live pane to a per-run log file, plus a one-shot `capture-pane`
 * for the scrollback backlog the viewer sees on connect. Every tmux argv is
 * built by a pure builder here and shell-escaped (single-quote with the
 * `'\''` idiom, matching TmuxLauncher) so a hostile session/log name cannot
 * inject a shell command into the `pipe-pane` shell-command argument.
 *
 * All real side effects (spawning tmux, tailing the file) live inside
 * `makeTermWebsocket`; the pure functions (`matchTermPath`,
 * `authenticateWsToken`, `buildPipePaneArgs`, `buildCapturePaneArgs`) are
 * hermetically testable with no tmux and no socket.
 *
 * INT wires this into `src/server/main.ts` Bun.serve: `websocket:
 * makeTermWebsocket(handle)` plus a `matchTermPath` + `handleTermUpgrade`
 * check at the top of `fetch(req, server)`.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DbHandle } from "../db/client.ts";
import { getRun } from "../runs/runs.ts";
import { RUN_TERMINAL_STATES } from "../db/columns.ts";

// ---------------------------------------------------------------------------
// Pure helpers (hermetically tested — no tmux, no socket)

/** "/runs/123/term" → 123; anything else → null. Pure. */
export function matchTermPath(pathname: string): number | null {
	const m = /^\/runs\/(\d+)\/term$/.exec(pathname);
	if (!m) return null;
	const id = Number(m[1]);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Bearer auth for the WS handshake: the token arrives as `?token=<bearer>`
 * (browsers cannot set Authorization on a WebSocket). Compared via SHA-256 +
 * timingSafeEqual against NIGHTSHIFT_API_TOKEN. Unset env ⇒ {ok:false,503};
 * missing/mismatched token ⇒ {ok:false,401}. Self-contained constant-time
 * compare so this module never imports/edits src/server/auth.ts.
 */
export function authenticateWsToken(url: URL): { ok: true } | { ok: false; status: 401 | 503 } {
	const expected = process.env.NIGHTSHIFT_API_TOKEN;
	if (!expected) return { ok: false, status: 503 };
	const presented = url.searchParams.get("token");
	if (!presented) return { ok: false, status: 401 };
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(expected).digest();
	if (!timingSafeEqual(a, b)) return { ok: false, status: 401 };
	return { ok: true };
}

/**
 * tmux argv that starts streaming the live pane into `logFile`. `-o` makes it
 * idempotent (replaces any existing pipe for the pane), so a reconnect never
 * stacks pipes. The shell-command argument is single-quote escaped so the log
 * path cannot break out of the `cat >>` redirection.
 */
export function buildPipePaneArgs(session: string, logFile: string): string[] {
	return ["tmux", "pipe-pane", "-o", "-t", session, `cat >> ${shq(logFile)}`];
}

/** tmux argv that prints the pane's recent scrollback (backlog on connect). */
export function buildCapturePaneArgs(session: string): string[] {
	return ["tmux", "capture-pane", "-pe", "-t", session, "-S", "-1000"];
}

/** Single-quote shell escape, matching TmuxLauncher's `'\''` idiom. */
function shq(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// WebSocket lifecycle

export interface TermSocketData {
	runId: number;
	tmuxSession: string;
	logFile: string;
}

/** Per-connection tail state, keyed off the ws's data.logFile. */
interface TailState {
	watcher: FSWatcher;
	offset: number;
	reading: boolean;
}

/**
 * Read-only WebSocket handler for a run's tmux pane. `message` is intentionally
 * a no-op: there is no path from client bytes to the pane, so the attach can
 * never write keystrokes (read-only by construction, not by check).
 */
export function makeTermWebsocket(handle: DbHandle): Bun.WebSocketHandler<TermSocketData> {
	void handle; // handle is validated at upgrade time; the socket needs no DB.
	const tails = new WeakMap<Bun.ServerWebSocket<TermSocketData>, TailState>();

	return {
		async open(ws) {
			const { tmuxSession, logFile } = ws.data;

			// 1) Send the scrollback backlog immediately so the viewer isn't blank.
			try {
				const backlog = await runTmux(buildCapturePaneArgs(tmuxSession));
				if (backlog.length > 0) ws.send(backlog);
			} catch {
				// Pane may have ended between upgrade and open; the tail still runs.
			}

			// 2) Start (idempotently) piping the live pane to the log file.
			try {
				await runTmux(buildPipePaneArgs(tmuxSession, logFile));
			} catch {
				// pipe-pane failure is non-fatal: the file may already be growing
				// from a prior attach (pipe-pane -o), and the tail below still works.
			}

			// 3) Tail the log file incrementally: send only newly-appended bytes.
			const startOffset = await fileSize(logFile);
			const state: TailState = {
				watcher: watch(logFile, { persistent: false }, () => {
					void drainTail(ws, tails);
				}),
				offset: startOffset,
				reading: false,
			};
			tails.set(ws, state);
		},

		// READ-ONLY: client → server bytes are dropped. No send-keys path exists.
		message() {},

		close(ws) {
			const state = tails.get(ws);
			if (state) {
				state.watcher.close();
				tails.delete(ws);
			}
			// pipe-pane keeps logging to the file; harmless and reused on reconnect.
		},
	};
}

/** Read appended bytes since the last offset and ws.send them. */
async function drainTail(
	ws: Bun.ServerWebSocket<TermSocketData>,
	tails: WeakMap<Bun.ServerWebSocket<TermSocketData>, TailState>,
): Promise<void> {
	const state = tails.get(ws);
	if (!state || state.reading) return;
	state.reading = true;
	try {
		const size = await fileSize(ws.data.logFile);
		if (size > state.offset) {
			const fh = await open(ws.data.logFile, "r");
			try {
				const len = size - state.offset;
				const buf = Buffer.allocUnsafe(len);
				const { bytesRead } = await fh.read(buf, 0, len, state.offset);
				if (bytesRead > 0) {
					ws.send(buf.subarray(0, bytesRead));
					state.offset += bytesRead;
				}
			} finally {
				await fh.close();
			}
		} else if (size < state.offset) {
			// Log truncated/rotated: reset so we don't read stale offsets.
			state.offset = size;
		}
	} catch {
		// File may have been removed on run teardown; ignore.
	} finally {
		state.reading = false;
	}
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

/** Spawn a tmux command, await exit, return stdout. Throws on non-zero exit. */
async function runTmux(argv: string[]): Promise<Uint8Array> {
	const proc = Bun.spawn(argv, {
		env: { ...process.env, LC_ALL: "C" } as Record<string, string>,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		proc.exited,
	]);
	if (code !== 0) {
		const err = await new Response(proc.stderr).text();
		throw new Error(`${argv[0]} ${argv[1]} failed (exit ${code}): ${err.trim()}`);
	}
	return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Fetch-side upgrade helper (used by main.ts before matchRoute)

/**
 * Validate that the run exists and has a live (non-terminal) tmux session,
 * authenticate the bearer token, then `server.upgrade`. Returns a Response on
 * refusal (503/401/404/409) and `undefined` once the socket is upgraded — at
 * which point Bun owns the connection.
 */
export function handleTermUpgrade(
	server: Bun.Server<TermSocketData>,
	req: Request,
	url: URL,
	handle: DbHandle,
): Response | undefined {
	const runId = matchTermPath(url.pathname);
	if (runId === null) return jsonRefusal(404, "not_found", `no terminal for ${url.pathname}`);

	const auth = authenticateWsToken(url);
	if (!auth.ok) {
		return auth.status === 503
			? jsonRefusal(503, "auth_not_configured", "NIGHTSHIFT_API_TOKEN is not set (fail closed)")
			: jsonRefusal(401, "unauthorized", "invalid or missing bearer token");
	}

	const run = getRun(handle, runId);
	if (!run) return jsonRefusal(404, "not_found", `run ${runId} not found`);
	if (!run.tmuxSession || run.homePath === null) {
		return jsonRefusal(409, "no_live_session", `run ${runId} has no live tmux session`);
	}
	if ((RUN_TERMINAL_STATES as readonly string[]).includes(run.state)) {
		return jsonRefusal(409, "run_terminal", `run ${runId} is ${run.state}; pane is gone`);
	}

	const data: TermSocketData = {
		runId,
		tmuxSession: run.tmuxSession,
		logFile: join(run.homePath, `term-${runId}.log`),
	};
	if (server.upgrade(req, { data })) return undefined;
	return jsonRefusal(400, "upgrade_failed", "expected a WebSocket upgrade request");
}

/** Minimal JSON error envelope (matches the server's `{error:{code,message}}`). */
function jsonRefusal(status: number, code: string, message: string): Response {
	return new Response(JSON.stringify({ error: { code, message } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
