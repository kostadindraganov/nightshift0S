/**
 * codex ProviderDriver (BLUEPRINT §3.12.13).
 *
 * Wraps the `codex` CLI. Key differences from claude-code:
 *   - cost_reporting: FALSE — usage parsing is claude-code-only per spec.
 *     Codex CLI does not expose token counts or USD cost in its output.
 *   - structured_output: via XML-tag extraction over stdout (same schemaRepair
 *     path as claude-code, UNTRUSTED until conformance proves it).
 *   - No fork capability declared.
 *
 * CLI invocation notes:
 *   codex --quiet <prompt>  non-interactive one-shot; --quiet suppresses the
 *                           spinner so stdout is clean for parsing.
 *   Session IDs: codex does not expose session continuation natively;
 *   resume is declared false accordingly.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderDriver } from "./types.ts";

const execFileAsync = promisify(execFile);

export const codex: ProviderDriver = {
	name: "codex",
	kind: "cli",

	declared: {
		interactive: true,
		resume: false,    // Codex CLI has no session-resume mechanism.
		fork: false,
		structured_output: true,   // XML-tag extraction over stdout (UNTRUSTED until proven)
		cost_reporting: false,     // Spec: usage parsing is claude-code-only; codex does NOT report cost.
		auth: ["api_key"],
		roles: ["coder", "reviewer", "utility", "experiment"],
	},

	async isAvailable() {
		try {
			await execFileAsync("which", ["codex"], { env: { ...process.env, LC_ALL: "C" } });
			return true;
		} catch {
			return false;
		}
	},

	async runOnce({ prompt, cwd }) {
		// Live path — only reached when CLI is present.
		const { stdout } = await execFileAsync(
			"codex",
			["--quiet", prompt],
			{
				cwd,
				env: { ...process.env, LC_ALL: "C" },
				// 5-minute wall-clock budget for a single probe turn.
				timeout: 5 * 60 * 1000,
			},
		);
		// Codex does not report usage — return stdout only, no telemetry.
		return { stdout };
	},

	async resumeOnce(_input) {
		// codex.declared.resume === false; this method should never be called
		// by the conformance harness or router. Throw defensively.
		throw new Error("codex: resume is not supported — this driver does not declare resume capability");
	},
};
