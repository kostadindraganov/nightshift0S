/**
 * C3 CLI driver tests — gemini (agy) / opencode / antigravity (task C3).
 *
 * WHY: the real binaries are ABSENT in this environment, so every case injects
 * a FAKE exec/which (no spawn, no PATH, no network). We assert the load-bearing
 * contract surface only: correct argv per driver, structured-output extraction
 * through the conformance probe, and the resume flag. <=5 hermetic cases total.
 */

import { describe, expect, test } from "bun:test";
import { makeGeminiDriver } from "./gemini.ts";
import { makeOpencodeDriver } from "./opencode.ts";
import { makeAntigravityDriver } from "./antigravity.ts";
import { PROBES, runConformance } from "./conformance.ts";
import type { ExecFn } from "./gemini.ts";

/** Records every exec invocation; returns a scripted stdout per call. */
function recordingExec(stdoutFor: (bin: string, args: string[]) => string): {
	exec: ExecFn;
	calls: { bin: string; args: string[]; cwd?: string }[];
} {
	const calls: { bin: string; args: string[]; cwd?: string }[] = [];
	const exec: ExecFn = async (bin, args, opts) => {
		calls.push({ bin, args, cwd: opts.cwd });
		return { stdout: stdoutFor(bin, args) };
	};
	return { exec, calls };
}

const whichTrue = async () => true;

// ---------------------------------------------------------------------------
// (1) gemini: runOnce builds correct argv and parses the JSON `response`.
// ---------------------------------------------------------------------------

test("gemini runOnce: correct argv + parses response/tokens from JSON", async () => {
	const { exec, calls } = recordingExec(() =>
		JSON.stringify({ response: "hi there", stats: { input_tokens: 11, output_tokens: 7 } }),
	);
	const driver = makeGeminiDriver({ exec, which: whichTrue });

	const out = await driver.runOnce({ prompt: "say hi", cwd: "/repo" });

	expect(calls[0]).toEqual({
		bin: "agy",
		args: ["-p", "say hi", "--output-format", "json"],
		cwd: "/repo",
	});
	expect(out.stdout).toBe("hi there");
	expect(out.tokensIn).toBe(11);
	expect(out.tokensOut).toBe(7);
	// Anti Gravity CLI reports no USD — cost_reporting must stay honest.
	expect(out.costUsd).toBeUndefined();
});

// ---------------------------------------------------------------------------
// (2) opencode: structured_output is PROVEN through the conformance probe by
//     reducing the NDJSON stream and extracting the <output> JSON.
// ---------------------------------------------------------------------------

test("opencode: structured_output proven + resume argv uses -s <sessionId>", async () => {
	const ndjson = [
		JSON.stringify({ type: "text", sessionID: "oc-1", text: '<output>{"ok":true}</output>' }),
		JSON.stringify({ type: "step-finish", cost: 0.002, tokens: { input: 30, output: 9 } }),
	].join("\n");
	const { exec, calls } = recordingExec(() => ndjson);
	const driver = makeOpencodeDriver({ exec, which: whichTrue });

	// structured_output + cost_reporting + resume probes all run against the fake.
	const report = await runConformance(driver, PROBES);
	expect(report.proven.structured_output).toBe(true);
	expect(report.proven.cost_reporting).toBe(true);
	expect(report.proven.resume).toBe(true); // sessionID surfaced → resume provable.

	// runOnce argv.
	expect(calls[0]!.args).toEqual(["run", "--format", "json", "Reply with the single word HELLO."]);
	// resumeOnce argv carries -s <sessionId>.
	const resumeCall = calls.find((c) => c.args.includes("-s"));
	expect(resumeCall?.args).toEqual([
		"run",
		"--format",
		"json",
		"-s",
		"oc-1",
		"What was the word you just said?",
	]);
});

// ---------------------------------------------------------------------------
// (3) gemini resume: -r <sessionId> flag, positional prompt (no -p).
// ---------------------------------------------------------------------------

test("gemini resumeOnce: argv is -r <sessionId> <prompt> --output-format json", async () => {
	const { exec, calls } = recordingExec(() => JSON.stringify({ response: "resumed" }));
	const driver = makeGeminiDriver({ exec, which: whichTrue });

	const out = await driver.resumeOnce({ sessionId: "g-42", prompt: "continue" });

	expect(calls[0]!.args).toEqual(["-r", "g-42", "continue", "--output-format", "json"]);
	expect(out.stdout).toBe("resumed");
});

// ---------------------------------------------------------------------------
// (4) antigravity: headless agy driver — correct argv + JSON parse.
// ---------------------------------------------------------------------------

test("antigravity runOnce: correct agy argv + parses response from JSON", async () => {
	const { exec, calls } = recordingExec(() =>
		JSON.stringify({ response: "hello from agy", stats: { input_tokens: 5, output_tokens: 3 } }),
	);
	const driver = makeAntigravityDriver({ exec, which: whichTrue });

	expect(await driver.isAvailable()).toBe(true);
	expect(driver.declared.roles).not.toEqual([]);

	const out = await driver.runOnce({ prompt: "say hello", cwd: "/repo" });

	expect(calls[0]).toEqual({
		bin: "agy",
		args: ["-p", "say hello", "--output-format", "json"],
		cwd: "/repo",
	});
	expect(out.stdout).toBe("hello from agy");
});
