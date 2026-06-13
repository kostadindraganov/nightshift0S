/**
 * antigravity ProviderDriver (BLUEPRINT §3.12.13).
 *
 * WHY: Wraps the Anti Gravity CLI (`agy`) as a candidate provider. The `agy`
 * binary is Google's Anti Gravity CLI (the renamed Gemini CLI) — a headless
 * one-shot CLI with the same interface as the former `gemini` binary.
 *
 *   - Headless one-shot: `agy -p "<prompt>" --output-format json`
 *   - Resume: `agy -r "<session-id>" "<prompt>"`
 *   - cost_reporting: FALSE — tokens reported but not USD.
 *   - structured_output: via XML-tag extraction (UNTRUSTED until proven).
 *
 * ALL side effects (PATH probe + exec) are injectable via `makeAntigravityDriver`
 * so argv/parse can be tested hermetically with fakes; the exported
 * `antigravity` const wires the real `node:child_process` execFile.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderDriver } from "./types.ts";
import type { WhichFn, ExecFn, ExecResult } from "./gemini.ts";

export interface AntigravityDeps {
	exec: ExecFn;
	which: WhichFn;
}

const ANTIGRAVITY_BIN = "agy";
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

interface AgyJsonOutput {
	response?: string;
	stats?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
	error?: { message?: string };
}

function parseAgyOutput(stdout: string): { stdout: string; tokensIn?: number; tokensOut?: number } {
	let parsed: AgyJsonOutput;
	try {
		parsed = JSON.parse(stdout) as AgyJsonOutput;
	} catch {
		return { stdout };
	}
	return {
		stdout: parsed.response ?? stdout,
		tokensIn: parsed.stats?.input_tokens,
		tokensOut: parsed.stats?.output_tokens,
	};
}

/**
 * Build an antigravity ProviderDriver with injected side effects. The exported
 * `antigravity` const calls this with the real exec/which.
 */
export function makeAntigravityDriver(deps: AntigravityDeps): ProviderDriver {
	return {
		name: "antigravity",
		kind: "cli",

		declared: {
			interactive: true,
			resume: true,
			fork: false,
			structured_output: true,
			cost_reporting: false,
			auth: ["api_key"],
			roles: ["coder", "reviewer", "planner", "utility", "experiment"],
		},

		async isAvailable() {
			return deps.which(ANTIGRAVITY_BIN);
		},

		async runOnce({ prompt, cwd }) {
			const { stdout } = await deps.exec(
				ANTIGRAVITY_BIN,
				["-p", prompt, "--output-format", "json"],
				{ cwd },
			);
			return parseAgyOutput(stdout);
		},

		async resumeOnce({ sessionId, prompt }) {
			// `agy -r "<session-id>" "<prompt>"` — positional prompt, no -p.
			const { stdout } = await deps.exec(
				ANTIGRAVITY_BIN,
				["-r", sessionId, prompt, "--output-format", "json"],
				{},
			);
			return { stdout: parseAgyOutput(stdout).stdout };
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
	return { stdout } as ExecResult;
};

/** The production Anti Gravity CLI driver (real side effects). */
export const antigravity: ProviderDriver = makeAntigravityDriver({ exec: realExec, which: realWhich });
