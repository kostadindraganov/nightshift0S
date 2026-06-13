/**
 * Tests for repo scanner (UNIT D-4 — AGENTS.md maintenance BLUEPRINT §3).
 *
 * Covers:
 *   1. Happy path: scanRepoSnapshot detects scripts, testDirs, topLevelDocs,
 *      detectedRuntime from a real temp repo structure.
 *   2. Runtime detection: bun (bun.lock), node (package.json), undefined (neither).
 *   3. FAIL-SOFT: non-existent dir returns empty snapshot, never throws.
 *
 * All tests are hermetic: temp dirs created via mkdtempSync, cleaned up after.
 * No network, no real FS dependencies outside the test temp area.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanRepoSnapshot } from "./repoScan.ts";
import type { RepoSnapshot } from "./agentsMd.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
	// Create a temp directory for each test.
	tempDir = mkdtempSync(join(process.cwd(), ".test-"));
});

afterEach(() => {
	// Clean up the temp directory.
	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup.
	}
});

// ---------------------------------------------------------------------------
// 1. Happy path: detects scripts, testDirs, topLevelDocs, detectedRuntime
// ---------------------------------------------------------------------------

test("scanRepoSnapshot detects structure from temp repo", () => {
	// Write a package.json with scripts.
	const pkgJson = {
		name: "test-repo",
		scripts: {
			test: "bun test",
			build: "bun run compile",
			lint: "eslint .",
		},
	};
	writeFileSync(join(tempDir, "package.json"), JSON.stringify(pkgJson, null, 2));

	// Write a bun.lock file (marks this as bun runtime).
	writeFileSync(join(tempDir, "bun.lock"), "");

	// Write some top-level markdown docs.
	writeFileSync(join(tempDir, "README.md"), "# Test Repo");
	writeFileSync(join(tempDir, "CONTRIBUTING.md"), "# Contribute");

	// Create a test directory (by name convention).
	const testDir = join(tempDir, "tests");
	mkdirSync(testDir, { recursive: true });
	writeFileSync(join(testDir, "index.test.ts"), "");

	// Create a src directory with some test files.
	const srcDir = join(tempDir, "src");
	mkdirSync(srcDir, { recursive: true });
	writeFileSync(join(srcDir, "main.ts"), "");
	writeFileSync(join(srcDir, "utils.test.ts"), "");

	const snapshot = scanRepoSnapshot(tempDir);

	// Verify scripts are parsed.
	expect(snapshot.scripts).toEqual({
		test: "bun test",
		build: "bun run compile",
		lint: "eslint .",
	});

	// Verify test directories are detected (both by name and by .test.* files).
	expect(snapshot.testDirs.sort()).toEqual(["src", "tests"].sort());

	// Verify top-level markdown docs.
	expect(snapshot.topLevelDocs.sort()).toEqual(["README.md", "CONTRIBUTING.md"].sort());

	// Verify runtime detection (bun.lock present).
	expect(snapshot.detectedRuntime).toBe("bun");

	// Verify rootEntries includes all top-level items.
	expect(snapshot.rootEntries).toContain("package.json");
	expect(snapshot.rootEntries).toContain("bun.lock");
	expect(snapshot.rootEntries).toContain("README.md");
	expect(snapshot.rootEntries).toContain("src");
	expect(snapshot.rootEntries).toContain("tests");
});

// ---------------------------------------------------------------------------
// 2. Runtime detection: bun vs node vs undefined
// ---------------------------------------------------------------------------

test("detects runtime correctly: bun.lock, package.json (no bun), neither", () => {
	// Case 1: bun runtime (bun.lock present).
	let snapshot = scanRepoSnapshot(tempDir);
	writeFileSync(join(tempDir, "bun.lock"), "");
	snapshot = scanRepoSnapshot(tempDir);
	expect(snapshot.detectedRuntime).toBe("bun");

	// Case 2: node runtime (package.json only, no bun.lock).
	rmSync(join(tempDir, "bun.lock"));
	writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "node-proj" }));
	snapshot = scanRepoSnapshot(tempDir);
	expect(snapshot.detectedRuntime).toBe("node");

	// Case 3: no runtime markers.
	rmSync(join(tempDir, "package.json"));
	snapshot = scanRepoSnapshot(tempDir);
	expect(snapshot.detectedRuntime).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 3. FAIL-SOFT: non-existent dir returns empty snapshot
// ---------------------------------------------------------------------------

test("non-existent dir returns empty snapshot without throwing", () => {
	const nonExistent = join(tempDir, "does", "not", "exist");
	const snapshot = scanRepoSnapshot(nonExistent);

	// Verify it matches the empty snapshot shape.
	const empty: RepoSnapshot = {
		rootEntries: [],
		scripts: {},
		testDirs: [],
		topLevelDocs: [],
		detectedRuntime: undefined,
	};
	expect(snapshot).toEqual(empty);
});
