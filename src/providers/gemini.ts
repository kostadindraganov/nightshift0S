/**
 * gemini ProviderDriver (BLUEPRINT §3.12.13).
 *
 * WHY: Wraps the Gemini CLI (`gemini`) as a candidate provider. Like every
 * non-claude-code driver its declared capabilities are a HYPOTHESIS only — the
 * conformance harness must PROVE each axis at runtime before the router will
 * use it. We encode an HONEST `declared` set grounded in the actual CLI surface:
 *
 *   - Headless one-shot: `gemini -p "<prompt>" --output-format json` emits a
 *     single JSON object { response, stats, error? }. `response` is the model
 *     text; `stats` carries token counts (input/output/total) but NO USD cost.
 *   - Resume: `gemini -r "<session-id>" "<prompt>"` resumes a session. BUT the
 *     headless JSON output does NOT surface a session_id (it only appears in the
 *     hook stdin envelope), so runOnce cannot return a sessionId today. We still
 *     declare resume:true honestly (the flag exists) — the conformance resume
 *     probe will then FAIL-CLOSED because runOnce yields no sessionId, and the
 *     router will refuse to use resume. That is the correct, honest outcome.
 *   - cost_reporting: FALSE. Gemini reports tokens but not USD; the cost probe
 *     requires costUsd > 0, so we do not claim it.
 *   - structured_output: via XML-tag extraction over `response` (same trust
 *     boundary as claude-code/codex; UNTRUSTED until the probe proves it).
 *
 * ALL side effects (PATH probe + exec) are injectable via `makeGeminiDriver`
 * so argv/parse can be tested hermetically with fakes; the exported `gemini`
 * const wires the real `node:child_process` execFile.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderDriver } from "./types.ts";

/** Result of an exec: stdout text only (stderr/exit handled by the caller's reject). */
export interface ExecResult {
	stdout: string;
}

/** Injectable exec seam — production binds this to execFile; tests pass a fake. */
export type ExecFn = (bin: string, args: string[], opts: { cwd?: string }) => Promise<ExecResult>;

/** Injectable PATH probe — resolves the binary name or null when absent. */
export type WhichFn = (bin: string) => Promise<boolean>;

export interface GeminiDeps {
	exec: ExecFn;
	which: WhichFn;
}

/** Shape of `gemini --output-format json` (only the fields we read). */
interface GeminiJsonOutput {
	response?: string;
	stats?: {
		input_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
	};
	error?: { message?: string };
}

const GEMINI_BIN = "gemini";
/** 5-minute wall-clock budget for a single probe turn (matches claude-code). */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Parse the headless JSON object. FAIL-CLOSED: on any parse failure we return
 * the raw stdout with no telemetry rather than fabricating values.
 */
function parseGeminiOutput(stdout: string): {
	stdout: string;
	tokensIn?: number;
	tokensOut?: number;
} {
	let parsed: GeminiJsonOutput;
	try {
		parsed = JSON.parse(stdout) as GeminiJsonOutput;
	} catch {
		return { stdout };
	}
	return {
		stdout: parsed.response ?? stdout,
		tokensIn: parsed.stats?.input_tokens,
		tokensOut: parsed.stats?.output_tokens,
		// NOTE: no costUsd — Gemini does not report USD. cost_reporting stays false.
	};
}

/**
 * Build a gemini ProviderDriver with injected side effects. The exported
 * `gemini` const calls this with the real exec/which.
 */
export function makeGeminiDriver(deps: GeminiDeps): ProviderDriver {
	return {
		name: "gemini",
		kind: "cli",

		declared: {
			interactive: true,
			resume: true, // `-r <id>` flag exists; resume probe fail-closes (no sessionId in headless JSON).
			fork: false,
			structured_output: true, // XML-tag extraction over `response` (UNTRUSTED until proven).
			cost_reporting: false, // Gemini reports tokens but NOT USD; do not claim it.
			auth: ["api_key"],
			roles: ["coder", "reviewer", "planner", "utility", "experiment"],
		},

		async isAvailable() {
			return deps.which(GEMINI_BIN);
		},

		async runOnce({ prompt, cwd }) {
			const { stdout } = await deps.exec(
				GEMINI_BIN,
				["-p", prompt, "--output-format", "json"],
				{ cwd },
			);
			// Headless JSON carries no session_id — sessionId is intentionally absent,
			// which makes the resume probe fail-closed (honest).
			return parseGeminiOutput(stdout);
		},

		async resumeOnce({ sessionId, prompt }) {
			// `gemini -r "<session-id>" "<prompt>"` — positional prompt, no -p.
			const { stdout } = await deps.exec(
				GEMINI_BIN,
				["-r", sessionId, prompt, "--output-format", "json"],
				{},
			);
			return { stdout: parseGeminiOutput(stdout).stdout };
		},
	};
}

// ---------------------------------------------------------------------------
// Production wiring — real PATH probe + execFile.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

const realWhich: WhichFn = async (bin) => {
	try {
		await execFileAsync("which", [bin], { env: { ...process.env, LC_ALL: "C" } });
		return true;
	} catch {
		return false;
	}
};

const realExec: ExecFn = async (bin, args, opts) => {
	const { stdout } = await execFileAsync(bin, args, {
		cwd: opts.cwd,
		env: { ...process.env, LC_ALL: "C" },
		timeout: TURN_TIMEOUT_MS,
	});
	return { stdout };
};

/** The production gemini driver (real side effects). */
export const gemini: ProviderDriver = makeGeminiDriver({ exec: realExec, which: realWhich });
