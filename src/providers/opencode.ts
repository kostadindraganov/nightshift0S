/**
 * opencode ProviderDriver (BLUEPRINT §3.12.13).
 *
 * WHY: Wraps the opencode CLI (`opencode run`). Its declared capabilities are a
 * HYPOTHESIS the conformance harness must PROVE — but opencode's headless surface
 * is unusually rich, so the honest `declared` set is broad:
 *
 *   - Headless one-shot: `opencode run --format json "<prompt>"` streams
 *     newline-delimited JSON "parts". We reduce that stream:
 *       · "text" parts          → concatenated into stdout; each carries sessionID.
 *       · "step-finish" parts   → carry { cost (USD), tokens { input, output } }.
 *   - Resume: `opencode run -s "<session-id>" "<prompt>"` continues a session.
 *     runOnce surfaces the sessionID from the text parts, so the resume probe
 *     can actually prove it (unlike gemini).
 *   - fork: `--fork` creates a new session from an existing one.
 *   - cost_reporting: TRUE — step-finish parts expose USD `cost` AND token
 *     counts natively (the only non-claude-code driver here that can prove it).
 *   - structured_output: via XML-tag extraction over the concatenated text
 *     (same trust boundary; UNTRUSTED until the probe proves it).
 *
 * ALL side effects (PATH probe + exec) are injectable via `makeOpencodeDriver`
 * so argv/parse can be tested hermetically with fakes; the exported `opencode`
 * const wires the real `node:child_process` execFile.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderDriver } from "./types.ts";
import type { ExecFn, ExecResult, WhichFn } from "./gemini.ts";

export interface OpencodeDeps {
	exec: ExecFn;
	which: WhichFn;
}

/** A single NDJSON part from `opencode run --format json` (only fields we read). */
interface OpencodePart {
	type?: string;
	sessionID?: string;
	text?: string;
	cost?: number;
	tokens?: { input?: number; output?: number };
}

const OPENCODE_BIN = "opencode";
/** 5-minute wall-clock budget for a single probe turn (matches claude-code). */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Reduce the NDJSON event stream into stdout + telemetry. FAIL-CLOSED: lines
 * that do not parse as JSON are skipped (never fabricated). Returns whatever
 * text/telemetry was actually present.
 */
function reduceOpencodeStream(stdout: string): {
	stdout: string;
	sessionId?: string;
	tokensIn?: number;
	tokensOut?: number;
	costUsd?: number;
} {
	let text = "";
	let sessionId: string | undefined;
	let tokensIn: number | undefined;
	let tokensOut: number | undefined;
	let costUsd: number | undefined;

	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let part: OpencodePart;
		try {
			part = JSON.parse(trimmed) as OpencodePart;
		} catch {
			continue; // Skip non-JSON noise; do not fabricate.
		}
		if (part.sessionID && sessionId === undefined) sessionId = part.sessionID;
		if (part.type === "text" && typeof part.text === "string") text += part.text;
		if (part.type === "step-finish") {
			if (typeof part.cost === "number") costUsd = part.cost;
			if (typeof part.tokens?.input === "number") tokensIn = part.tokens.input;
			if (typeof part.tokens?.output === "number") tokensOut = part.tokens.output;
		}
	}

	return {
		// If no text parts arrived, fall back to raw stdout so extraction can still try.
		stdout: text !== "" ? text : stdout,
		sessionId,
		tokensIn,
		tokensOut,
		costUsd,
	};
}

/**
 * Build an opencode ProviderDriver with injected side effects. The exported
 * `opencode` const calls this with the real exec/which.
 */
export function makeOpencodeDriver(deps: OpencodeDeps): ProviderDriver {
	return {
		name: "opencode",
		kind: "cli",

		declared: {
			interactive: true,
			resume: true, // `-s <id>` / `-c` continue a session; sessionID is surfaced.
			fork: true, // `--fork` branches a session.
			structured_output: true, // XML-tag extraction over text parts (UNTRUSTED until proven).
			cost_reporting: true, // step-finish exposes USD cost + tokens natively.
			auth: ["api_key"],
			roles: ["coder", "reviewer", "planner", "judge", "utility", "experiment"],
		},

		async isAvailable() {
			return deps.which(OPENCODE_BIN);
		},

		async runOnce({ prompt, cwd }) {
			const { stdout } = await deps.exec(
				OPENCODE_BIN,
				["run", "--format", "json", prompt],
				{ cwd },
			);
			return reduceOpencodeStream(stdout);
		},

		async resumeOnce({ sessionId, prompt }) {
			// `-s <session-id>` continues the named session; prompt is positional.
			const { stdout } = await deps.exec(
				OPENCODE_BIN,
				["run", "--format", "json", "-s", sessionId, prompt],
				{},
			);
			return { stdout: reduceOpencodeStream(stdout).stdout };
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

const realExec: ExecFn = async (bin, args, opts): Promise<ExecResult> => {
	const { stdout } = await execFileAsync(bin, args, {
		cwd: opts.cwd,
		env: { ...process.env, LC_ALL: "C" },
		timeout: TURN_TIMEOUT_MS,
		// opencode streams many parts; allow a generous buffer.
		maxBuffer: 32 * 1024 * 1024,
	});
	return { stdout };
};

/** The production opencode driver (real side effects). */
export const opencode: ProviderDriver = makeOpencodeDriver({ exec: realExec, which: realWhich });
