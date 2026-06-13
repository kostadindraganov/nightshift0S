/**
 * WHY: Builds a RepoSnapshot from a real local checkout so the AGENTS.md
 * proposer (proposeAgentsMd, src/maintenance/agentsMd.ts) can be wired to
 * an actual repo on disk without the proposer itself touching the filesystem.
 *
 * BLUEPRINT §3 "AGENTS.md auto-maintenance" — the CODE-COMPLETE seam between
 * the FS and the pure proposer. Read-only; no writes, no network calls.
 *
 * FAIL-SOFT: a missing or unreadable repoDir returns an empty snapshot and
 * never throws, so a misconfigured host degrades gracefully instead of
 * crashing the maintenance loop.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RepoSnapshot } from "./agentsMd.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return true if `name` likely indicates a test/spec directory. */
function isTestDirByName(name: string): boolean {
	return /test|spec/i.test(name);
}

/**
 * Shallow scan: return true if `dirPath` contains at least one file whose
 * name matches *.test.* (e.g. foo.test.ts).
 * Best-effort — silently returns false on any error.
 */
function containsTestFiles(dirPath: string): boolean {
	try {
		const entries = readdirSync(dirPath);
		return entries.some((e) => /\.test\./.test(e));
	} catch {
		return false;
	}
}

/**
 * Parse the "scripts" field from package.json at `pkgPath`.
 * Returns {} on any parse / read error (fail-soft).
 */
function parseScripts(pkgPath: string): Record<string, string> {
	try {
		const raw = readFileSync(pkgPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			"scripts" in parsed &&
			typeof (parsed as Record<string, unknown>).scripts === "object" &&
			(parsed as Record<string, unknown>).scripts !== null
		) {
			const scripts = (parsed as Record<string, unknown>).scripts as Record<string, unknown>;
			const result: Record<string, string> = {};
			for (const [k, v] of Object.entries(scripts)) {
				if (typeof v === "string") result[k] = v;
			}
			return result;
		}
	} catch {
		// fail-soft
	}
	return {};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan `repoDir` and return a RepoSnapshot suitable for passing to
 * `proposeAgentsMd`. Never throws — a missing/unreadable dir returns an
 * empty snapshot with all arrays/objects empty and no detectedRuntime.
 */
export function scanRepoSnapshot(repoDir: string): RepoSnapshot {
	const empty: RepoSnapshot = {
		rootEntries: [],
		scripts: {},
		testDirs: [],
		topLevelDocs: [],
		detectedRuntime: undefined,
	};

	let topLevel: string[];
	try {
		topLevel = readdirSync(repoDir);
	} catch {
		return empty;
	}

	// Classify top-level entries.
	const rootEntries: string[] = topLevel;
	const testDirs: string[] = [];
	const topLevelDocs: string[] = [];
	let hasBunLock = false;
	let hasPackageJson = false;

	for (const name of topLevel) {
		const fullPath = join(repoDir, name);

		// Detect runtime markers.
		if (name === "bun.lock" || name === "bunfig.toml") hasBunLock = true;
		if (name === "package.json") hasPackageJson = true;

		// Collect top-level *.md files.
		if (/\.md$/i.test(name)) {
			topLevelDocs.push(name);
			continue;
		}

		// Check if this is a directory that looks like a test dir.
		let isDir = false;
		try {
			isDir = statSync(fullPath).isDirectory();
		} catch {
			continue;
		}

		if (!isDir) continue;

		if (isTestDirByName(name) || containsTestFiles(fullPath)) {
			testDirs.push(name);
		}
	}

	// Parse scripts from package.json (best-effort).
	const scripts = hasPackageJson
		? parseScripts(join(repoDir, "package.json"))
		: {};

	// Detect runtime.
	const detectedRuntime: string | undefined = hasBunLock
		? "bun"
		: hasPackageJson
			? "node"
			: undefined;

	return {
		rootEntries,
		scripts,
		testDirs,
		topLevelDocs,
		detectedRuntime,
	};
}
