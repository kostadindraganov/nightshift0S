/**
 * WHY: CLI auto-update panel (BLUEPRINT V3 §cli-update) keeps agent CLIs
 * (claude, codex, gemini, …) current and surfaces version/update status on a
 * read-only panel. All side effects (exec + which) are injectable so the
 * logic is testable hermetically.
 *
 * Design decisions:
 *   - FAIL-SOFT: update() catches ALL errors and returns {ok:false,error}.
 *     It NEVER throws. A failed update must not crash a run.
 *   - HONEST: updateAvailable is false whenever installed or latest cannot
 *     be parsed. We never claim an update we cannot prove.
 *   - DEFAULT_CLI_TARGETS carries no latestArgs/updateArgs — those are
 *     operator-supplied. Without them, latest stays null and updateAvailable
 *     stays false, which is the honest default.
 *   - No Date.now()/Math.random() in pure logic. No secrets logged.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CliTarget {
	provider: string;
	bin: string;
	versionArgs: string[];
	latestArgs?: string[];
	updateArgs?: string[];
}

export interface CliStatus {
	provider: string;
	bin: string;
	installed: string | null;
	latest: string | null;
	updateAvailable: boolean;
	error?: string;
}

/** Injectable exec seam — production binds to execFile; tests pass a fake. */
export type ExecFn = (bin: string, args: string[]) => Promise<{ stdout: string }>;

/** Injectable PATH probe — true when the binary is on PATH, false otherwise. */
export type WhichFn = (bin: string) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first `x.y.z` triplet from arbitrary `--version` output.
 * Returns null when no valid semver triplet is found.
 */
export function parseSemver(s: string): [number, number, number] | null {
	const m = s.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)];
}

/**
 * True ONLY when both installed and latest parse and installed < latest.
 * False when either is null or unparseable — fail-soft: never claim an
 * update we cannot prove.
 */
export function needsUpdate(installed: string | null, latest: string | null): boolean {
	if (installed === null || latest === null) return false;
	const a = parseSemver(installed);
	const b = parseSemver(latest);
	if (a === null || b === null) return false;
	// Compare major, then minor, then patch.
	if (a[0] !== b[0]) return a[0] < b[0];
	if (a[1] !== b[1]) return a[1] < b[1];
	return a[2] < b[2];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makeCliUpdater(deps: { exec: ExecFn; which: WhichFn }): {
	status(targets: CliTarget[]): Promise<CliStatus[]>;
	update(target: CliTarget): Promise<{ ok: boolean; error?: string }>;
} {
	return {
		async status(targets) {
			return Promise.all(
				targets.map(async (t): Promise<CliStatus> => {
					try {
						const present = await deps.which(t.bin);
						if (!present) {
							return {
								provider: t.provider,
								bin: t.bin,
								installed: null,
								latest: null,
								updateAvailable: false,
							};
						}

						// Resolve installed version.
						let installed: string | null = null;
						try {
							const { stdout } = await deps.exec(t.bin, t.versionArgs);
							const parsed = parseSemver(stdout);
							installed = parsed !== null ? `${parsed[0]}.${parsed[1]}.${parsed[2]}` : null;
						} catch (err) {
							return {
								provider: t.provider,
								bin: t.bin,
								installed: null,
								latest: null,
								updateAvailable: false,
								error: String(err),
							};
						}

						// Resolve latest version (optional — operator-supplied).
						let latest: string | null = null;
						if (t.latestArgs !== undefined) {
							try {
								const { stdout } = await deps.exec(t.bin, t.latestArgs);
								const parsed = parseSemver(stdout);
								latest = parsed !== null ? `${parsed[0]}.${parsed[1]}.${parsed[2]}` : null;
							} catch {
								// fail-soft: latest stays null; updateAvailable stays false.
							}
						}

						return {
							provider: t.provider,
							bin: t.bin,
							installed,
							latest,
							updateAvailable: needsUpdate(installed, latest),
						};
					} catch (err) {
						// Per-target catch — never throw out of status().
						return {
							provider: t.provider,
							bin: t.bin,
							installed: null,
							latest: null,
							updateAvailable: false,
							error: String(err),
						};
					}
				}),
			);
		},

		async update(target) {
			// FAIL-SOFT: catch everything, never throw.
			try {
				if (!target.updateArgs || target.updateArgs.length === 0) {
					return { ok: false, error: "no update command" };
				}
				await deps.exec(target.bin, target.updateArgs);
				return { ok: true };
			} catch (err) {
				return { ok: false, error: String(err) };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Default targets
// ---------------------------------------------------------------------------

/**
 * Best-effort defaults for known CLIs. No latestArgs/updateArgs — those are
 * operator-supplied. Without them, latest=null and updateAvailable=false,
 * which is the honest default until the operator configures update commands.
 */
export const DEFAULT_CLI_TARGETS: CliTarget[] = [
	{ provider: "claude", bin: "claude", versionArgs: ["--version"] },
	{ provider: "codex", bin: "codex", versionArgs: ["--version"] },
	{ provider: "gemini", bin: "gemini", versionArgs: ["--version"] },
];

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

const realExec: ExecFn = async (bin, args) => {
	const { stdout } = await execFileAsync(bin, args, {
		env: { ...process.env, LC_ALL: "C" },
	});
	return { stdout };
};

/** The production CLI updater (real side effects). */
export const cliUpdater = makeCliUpdater({ exec: realExec, which: realWhich });
