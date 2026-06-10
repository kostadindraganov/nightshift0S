/**
 * claude-code ProviderDriver (BLUEPRINT §3.12.13).
 *
 * Wraps the `claude` / `claude-code` CLI. This is the primary driver today:
 * the only one with proven cost_reporting (tokens + USD from --output-format
 * json), interactive session support, and fork capability.
 *
 * CLI invocation notes:
 *   --print              non-interactive one-shot mode (no TTY needed).
 *   --output-format json emit structured JSON including usage stats.
 *   --resume <id>        resume a prior session by its session ID.
 *
 * These invocations are exercised only when the CLI is present on PATH. Tests
 * use a fake driver — see conformance.test.ts.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderDriver } from "./types.ts";

const execFileAsync = promisify(execFile);

/** Resolve "claude" or "claude-code" whichever is on PATH first. */
async function resolveClaudeBin(): Promise<string | null> {
	for (const bin of ["claude", "claude-code"]) {
		try {
			await execFileAsync("which", [bin], { env: { ...process.env, LC_ALL: "C" } });
			return bin;
		} catch {
			// Not found, try next.
		}
	}
	return null;
}

interface ClaudeJsonOutput {
	result?: string;
	session_id?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
	};
	cost_usd?: number;
}

export const claudeCode: ProviderDriver = {
	name: "claude-code",
	kind: "cli",

	declared: {
		interactive: true,
		resume: true,
		fork: true,
		structured_output: true, // XML-tag extraction via schemaRepair.ts (UNTRUSTED until proven)
		cost_reporting: true,    // Spec: usage parsing is claude-code-only (§3.12.13)
		auth: ["subscription", "api_key"],
		roles: ["coder", "reviewer", "planner", "judge", "utility"],
	},

	async isAvailable() {
		const bin = await resolveClaudeBin();
		return bin !== null;
	},

	async runOnce({ prompt, cwd }) {
		// Live path — only reached when CLI is present.
		const bin = await resolveClaudeBin();
		if (!bin) throw new Error("claude-code: CLI not found on PATH");

		const { stdout } = await execFileAsync(
			bin,
			["--print", "--output-format", "json", prompt],
			{
				cwd,
				env: { ...process.env, LC_ALL: "C" },
				// 5-minute wall-clock budget for a single probe turn.
				timeout: 5 * 60 * 1000,
			},
		);

		let parsed: ClaudeJsonOutput = {};
		try {
			parsed = JSON.parse(stdout) as ClaudeJsonOutput;
		} catch {
			// Fallback: return raw stdout, no telemetry.
			return { stdout };
		}

		return {
			stdout: parsed.result ?? stdout,
			sessionId: parsed.session_id,
			tokensIn: parsed.usage?.input_tokens,
			tokensOut: parsed.usage?.output_tokens,
			costUsd: parsed.cost_usd,
		};
	},

	async resumeOnce({ sessionId, prompt }) {
		const bin = await resolveClaudeBin();
		if (!bin) throw new Error("claude-code: CLI not found on PATH");

		const { stdout } = await execFileAsync(
			bin,
			["--print", "--output-format", "json", "--resume", sessionId, prompt],
			{
				env: { ...process.env, LC_ALL: "C" },
				timeout: 5 * 60 * 1000,
			},
		);

		let parsed: ClaudeJsonOutput = {};
		try {
			parsed = JSON.parse(stdout) as ClaudeJsonOutput;
		} catch {
			return { stdout };
		}

		return { stdout: parsed.result ?? stdout };
	},
};
