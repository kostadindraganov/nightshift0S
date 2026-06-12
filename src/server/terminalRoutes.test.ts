/**
 * WHY: Hermetic coverage of L4's pure surface — NO real tmux, NO real socket.
 * Asserts the tmux argv builders (incl. shell-escaping against injection),
 * path matching, and the constant-time WS auth gate (503 unset / 401 mismatch
 * / ok). The live tail + upgrade are Linux-verify-only per the contract.
 */

import { describe, expect, test, afterEach } from "bun:test";
import {
	matchTermPath,
	authenticateWsToken,
	buildPipePaneArgs,
	buildCapturePaneArgs,
} from "./terminalRoutes.ts";

const ORIGINAL_TOKEN = process.env.NIGHTSHIFT_API_TOKEN;
afterEach(() => {
	if (ORIGINAL_TOKEN === undefined) delete process.env.NIGHTSHIFT_API_TOKEN;
	else process.env.NIGHTSHIFT_API_TOKEN = ORIGINAL_TOKEN;
});

describe("terminalRoutes", () => {
	test("matchTermPath extracts a positive run id, else null", () => {
		expect(matchTermPath("/runs/123/term")).toBe(123);
		expect(matchTermPath("/runs/0/term")).toBeNull();
		expect(matchTermPath("/runs/abc/term")).toBeNull();
		expect(matchTermPath("/runs/123")).toBeNull();
		expect(matchTermPath("/runs/123/term/extra")).toBeNull();
	});

	test("tmux argv builders are exact and shell-escape the log path", () => {
		expect(buildCapturePaneArgs("ns-run-7")).toEqual([
			"tmux", "capture-pane", "-pe", "-t", "ns-run-7", "-S", "-1000",
		]);
		// Benign log path is single-quoted inside the shell-command arg.
		expect(buildPipePaneArgs("ns-run-7", "/home/x/term-7.log")).toEqual([
			"tmux", "pipe-pane", "-o", "-t", "ns-run-7", "cat >> '/home/x/term-7.log'",
		]);
		// Injection attempt: the embedded quote+`;` is neutralised by '\'' escaping,
		// so the shell sees one literal string, never a second command.
		const evilArg = buildPipePaneArgs("s", "/t/x'; rm -rf ~ #.log")[5] ?? "";
		expect(evilArg).toBe("cat >> '/t/x'\\''; rm -rf ~ #.log'");
		// The user's single quote was rewritten to the '\'' idiom, so it cannot
		// terminate the surrounding literal — there is no bare `'; ` break-out.
		expect(evilArg).toContain("/t/x'\\''; rm");
		expect(evilArg.endsWith("'")).toBe(true); // still inside one quoted literal
	});

	test("authenticateWsToken: 503 when env unset", () => {
		delete process.env.NIGHTSHIFT_API_TOKEN;
		expect(authenticateWsToken(new URL("ws://h/runs/1/term?token=anything"))).toEqual({
			ok: false,
			status: 503,
		});
	});

	test("authenticateWsToken: 401 on missing/mismatch, ok on exact match", () => {
		process.env.NIGHTSHIFT_API_TOKEN = "s3cret";
		expect(authenticateWsToken(new URL("ws://h/runs/1/term"))).toEqual({ ok: false, status: 401 });
		expect(authenticateWsToken(new URL("ws://h/runs/1/term?token=nope"))).toEqual({
			ok: false,
			status: 401,
		});
		expect(authenticateWsToken(new URL("ws://h/runs/1/term?token=s3cret"))).toEqual({ ok: true });
	});
});
