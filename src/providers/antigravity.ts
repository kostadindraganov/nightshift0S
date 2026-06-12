/**
 * antigravity ProviderDriver (BLUEPRINT §3.12.13).
 *
 * WHY: Google Antigravity is an agentic IDE (a VS Code fork, sibling to
 * Cursor/Windsurf), NOT a headless one-shot CLI. Its `antigravity` binary
 * launches the editor / Agent Manager — there is NO documented, stable
 * non-interactive `prompt → structured stdout` invocation today. The agent is
 * driven through the GUI, with global rules at ~/.gemini/GEMINI.md.
 *
 * Honesty + FAIL-CLOSED is the whole point here:
 *   - We register the driver so it appears in the roster and can be re-probed
 *     if/when a headless surface ships, but we declare ONLY what is real:
 *       · interactive: false  — no scriptable stdin/stdout ping-pong.
 *       · resume / fork / structured_output / cost_reporting: false.
 *       · roles: []           — the router will never select it for any role.
 *   - runOnce/resumeOnce THROW rather than spawning the editor. A speculative
 *     unstructured stdout scrape would let an UNPROVEN capability leak into the
 *     pipeline, which violates the trust boundary. Throwing makes every
 *     conformance probe record "failed", so `proven` stays all-false.
 *
 * isAvailable() still PATH-probes the `antigravity` launcher so the roster can
 * report presence; presence alone never grants capability.
 *
 * ALL side effects (PATH probe + exec) are injectable via `makeAntigravityDriver`
 * so the contract can be tested hermetically with fakes; the exported
 * `antigravity` const wires the real `node:child_process` execFile probe.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderDriver } from "./types.ts";
import type { WhichFn } from "./gemini.ts";

export interface AntigravityDeps {
	which: WhichFn;
}

const ANTIGRAVITY_BIN = "antigravity";

const NO_HEADLESS =
	"antigravity: no headless one-shot CLI — it is an IDE/Agent-Manager launcher; " +
	"capability cannot be proven, so this method is intentionally unsupported (fail-closed)";

/**
 * Build an antigravity ProviderDriver with an injected PATH probe. The exported
 * `antigravity` const calls this with the real `which`.
 */
export function makeAntigravityDriver(deps: AntigravityDeps): ProviderDriver {
	return {
		name: "antigravity",
		kind: "cli",

		declared: {
			// Honest: the launcher exposes no scriptable, structured, headless surface.
			interactive: false,
			resume: false,
			fork: false,
			structured_output: false,
			cost_reporting: false,
			auth: ["api_key"],
			roles: [], // No roles → router never selects it (fail-closed at the gate).
		},

		async isAvailable() {
			// Presence is reportable; it never implies capability.
			return deps.which(ANTIGRAVITY_BIN);
		},

		async runOnce() {
			throw new Error(NO_HEADLESS);
		},

		async resumeOnce() {
			throw new Error(NO_HEADLESS);
		},
	};
}

// ---------------------------------------------------------------------------
// Production wiring — real PATH probe only (no exec: there is no headless call).
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

/** The production antigravity driver (real PATH probe). */
export const antigravity: ProviderDriver = makeAntigravityDriver({ which: realWhich });
