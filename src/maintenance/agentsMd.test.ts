/**
 * Tests for AGENTS.md auto-maintenance (BLUEPRINT §3 "AGENTS.md auto-maintenance").
 *
 * Covers:
 *   1. proposeAgentsMd happy path: builds a managed block from a snapshot, preserves
 *      prose outside the block, detects when current is already up-to-date.
 *   2. mergeManagedBlock: inserts/replaces ONLY the managed block, preserving rest.
 *   3. Edge cases: empty snapshot, huge entries (guarded at 40), injection in strings.
 *   4. LlmRefine hook: applied if provided, fail-closed if it throws.
 *   5. FAIL-CLOSED: secrets/tokens never in error payloads, project_not_found → 404,
 *      bad project id → 400, route returns well-formed JSON body.
 *
 * All tests are hermetic: no real FS, no network. Snapshots are fakes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RepoSnapshot, AgentsMdProposal } from "./agentsMd.ts";
import {
	proposeAgentsMd,
	mergeManagedBlock,
	type LlmRefine,
} from "./agentsMd.ts";
import { agentsMdRoutes } from "./agentsMdRoutes.ts";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { EventLog } from "../events/events.ts";
import { projects } from "../db/schema.ts";

// ---------------------------------------------------------------------------
// DB fixtures (used by route tests only — pure-function tests don't need a DB)
// ---------------------------------------------------------------------------

let handle: DbHandle;
let log: EventLog;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
});

afterEach(() => {
	handle.sqlite.close();
});

/** Insert a project row and return its id. */
function seedProject(name = "test-project"): number {
	const now = new Date().toISOString();
	return handle.db
		.insert(projects)
		.values({
			name,
			repoUrl: "https://github.com/test/repo",
			defaultBranch: "main",
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: projects.id })
		.get().id;
}

/** Invoke a route handler by name, returns { status, body }. */
async function callRoute(
	routePath: string,
	params: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
	const route = agentsMdRoutes.find((r) => r.path === routePath);
	if (route === undefined) throw new Error(`Route not found: ${routePath}`);
	const req = new Request(`http://localhost${routePath}`);
	const url = new URL(req.url);
	const ctx = { req, url, params, handle, events: log };
	const res = await route.handler(ctx);
	const body = await res.json();
	return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Fixtures & Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal valid snapshot for testing (represents a basic project).
 */
function minimalSnapshot(): RepoSnapshot {
	return {
		rootEntries: ["src/", "package.json", "README.md"],
		scripts: { test: "bun test" },
		testDirs: ["src/"],
		topLevelDocs: ["README.md"],
		detectedRuntime: "bun",
	};
}

/**
 * A snapshot with many entries (to test guards against huge repos).
 */
function hugeSnapshot(): RepoSnapshot {
	const entries = Array.from({ length: 60 }, (_, i) => `file-${i}.txt`);
	return {
		rootEntries: entries,
		scripts: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`script-${i}`, `cmd ${i}`])),
		testDirs: Array.from({ length: 25 }, (_, i) => `test-dir-${i}/`),
		topLevelDocs: Array.from({ length: 35 }, (_, i) => `doc-${i}.md`),
		detectedRuntime: "node",
	};
}

/**
 * A snapshot with injection-prone strings (HTML tags, control chars).
 */
function injectionSnapshot(): RepoSnapshot {
	return {
		rootEntries: [
			"src/",
			"<script>alert('xss')</script>",
			"file\x00with\x01control\x02chars.txt",
		],
		scripts: {
			test: "bun test && echo '<output>done</output>'",
			build: "npm run <build>",
		},
		testDirs: [
			"src/__tests__/",
			"<output>test</output>",
		],
		topLevelDocs: [
			"README.md",
			"</output>injected</output>",
		],
		detectedRuntime: "bun",
	};
}

// ---------------------------------------------------------------------------
// Test: proposeAgentsMd happy path
// ---------------------------------------------------------------------------

test("proposeAgentsMd: builds managed block from snapshot (no current)", async () => {
	const snapshot = minimalSnapshot();
	const result = await proposeAgentsMd({ current: null, snapshot });

	expect(result.changed).toBe(true);
	expect(result.sections).toContain("runtime");
	expect(result.sections).toContain("layout");
	expect(result.sections).toContain("scripts");
	expect(result.sections).toContain("conventions");

	// Proposal should contain the managed-block markers.
	expect(result.proposal).toContain("<!-- nightshift:agents-md:begin -->");
	expect(result.proposal).toContain("<!-- :end -->");

	// Proposal should contain expected content from the snapshot.
	expect(result.proposal).toContain("## Runtime");
	expect(result.proposal).toContain("`bun`");
	expect(result.proposal).toContain("## Project Layout");
	expect(result.proposal).toContain("## Scripts");
	expect(result.proposal).toContain("`test`");
	expect(result.proposal).toContain("`bun test`");
});

test("proposeAgentsMd: detects when current is already up-to-date (changed=false)", async () => {
	const snapshot = minimalSnapshot();
	const proposal1 = await proposeAgentsMd({ current: null, snapshot });

	// Use the generated proposal as the current content for the second call.
	const proposal2 = await proposeAgentsMd({ current: proposal1.proposal, snapshot });

	// Same snapshot should produce changed=false.
	expect(proposal2.changed).toBe(false);
	expect(proposal2.proposal).toEqual(proposal1.proposal);
});

test("proposeAgentsMd: preserves hand-written prose outside managed block", async () => {
	const snapshot = minimalSnapshot();
	const handWritten = `# My Custom Project

This is my custom preamble that I wrote by hand.

<!-- nightshift:agents-md:begin -->
old managed block
<!-- :end -->

And this is a postscript that should be preserved.
`;

	const result = await proposeAgentsMd({ current: handWritten, snapshot });

	// Hand-written preamble and postscript should still be there.
	expect(result.proposal).toContain("My Custom Project");
	expect(result.proposal).toContain("custom preamble");
	expect(result.proposal).toContain("postscript");

	// Old managed block should be replaced.
	expect(result.proposal).not.toContain("old managed block");

	// New managed block should be there.
	expect(result.proposal).toContain("<!-- nightshift:agents-md:begin -->");
	expect(result.proposal).toContain("<!-- :end -->");
});

test("proposeAgentsMd: detects changes when snapshot differs from current", async () => {
	const snapshot1 = minimalSnapshot();
	const proposal1 = await proposeAgentsMd({ current: null, snapshot: snapshot1 });

	// Modify the snapshot (add a new script).
	const snapshot2: RepoSnapshot = {
		...snapshot1,
		scripts: { ...snapshot1.scripts, build: "bun run build" },
	};
	const proposal2 = await proposeAgentsMd({ current: proposal1.proposal, snapshot: snapshot2 });

	// Changed should be true because the snapshot differs.
	expect(proposal2.changed).toBe(true);
	expect(proposal2.proposal).toContain("build");
});

// ---------------------------------------------------------------------------
// Test: mergeManagedBlock
// ---------------------------------------------------------------------------

test("mergeManagedBlock: appends block when no existing block present", () => {
	const current = "# My Docs\n\nSome content here.\n";
	const block = "<!-- nightshift:agents-md:begin -->\nNew managed block\n<!-- :end -->";

	const result = mergeManagedBlock(current, block);

	// Should preserve the original content and append the block with separator.
	expect(result).toContain("My Docs");
	expect(result).toContain("Some content here");
	expect(result).toContain(block);
});

test("mergeManagedBlock: replaces existing block in place", () => {
	const current = `# Title
Before block.
<!-- nightshift:agents-md:begin -->
Old managed content here
<!-- :end -->
After block.`;

	const newBlock = "<!-- nightshift:agents-md:begin -->\nNew managed content\n<!-- :end -->";
	const result = mergeManagedBlock(current, newBlock);

	expect(result).toContain("Before block.");
	expect(result).toContain("After block.");
	expect(result).not.toContain("Old managed content");
	expect(result).toContain("New managed content");
});

test("mergeManagedBlock: handles null current (treats as empty string)", () => {
	const block = "<!-- nightshift:agents-md:begin -->\nContent\n<!-- :end -->";
	const result = mergeManagedBlock(null, block);

	expect(result).toBe(block);
});

test("mergeManagedBlock: handles empty string current", () => {
	const block = "<!-- nightshift:agents-md:begin -->\nContent\n<!-- :end -->";
	const result = mergeManagedBlock("", block);

	expect(result).toBe(block);
});

test("mergeManagedBlock: adds proper separators (newlines) before block", () => {
	// Test with no trailing newline.
	const current1 = "Some content";
	const block = "<!-- nightshift:agents-md:begin -->\nContent\n<!-- :end -->";
	const result1 = mergeManagedBlock(current1, block);

	expect(result1).toContain("Some content\n\n<!-- nightshift:agents-md:begin -->");

	// Test with one trailing newline.
	const current2 = "Some content\n";
	const result2 = mergeManagedBlock(current2, block);

	expect(result2).toContain("Some content\n\n<!-- nightshift:agents-md:begin -->");

	// Test with two trailing newlines.
	const current3 = "Some content\n\n";
	const result3 = mergeManagedBlock(current3, block);

	expect(result3).toContain("Some content\n\n<!-- nightshift:agents-md:begin -->");
});

test("mergeManagedBlock: ignores mismatched markers (no begin without end)", () => {
	const current = "Content\n<!-- nightshift:agents-md:begin -->\nNo closing marker";
	const block = "<!-- nightshift:agents-md:begin -->\nNew\n<!-- :end -->";

	const result = mergeManagedBlock(current, block);

	// Should treat it as no block found and append.
	expect(result).toContain("Content");
	expect(result).toContain("No closing marker");
	expect(result).toContain("New");
});

// ---------------------------------------------------------------------------
// Test: Edge cases — empty/minimal snapshots
// ---------------------------------------------------------------------------

test("proposeAgentsMd: handles empty snapshot gracefully", async () => {
	const emptySnapshot: RepoSnapshot = {
		rootEntries: [],
		scripts: {},
		testDirs: [],
		topLevelDocs: [],
	};

	const result = await proposeAgentsMd({ current: null, snapshot: emptySnapshot });

	expect(result.changed).toBe(true);
	expect(result.sections.length).toBeGreaterThan(0);

	// Should still generate conventions and runtime sections.
	expect(result.proposal).toContain("## Conventions");
	expect(result.proposal).toContain("## Runtime");

	// No layout/scripts/docs sections when empty.
	// (The code skips sections if the list is empty.)
	expect(result.sections).toContain("runtime");
	expect(result.sections).toContain("conventions");
});

test("proposeAgentsMd: no detectedRuntime defaults to 'unknown'", async () => {
	const snapshot: RepoSnapshot = {
		rootEntries: ["src/"],
		scripts: {},
		testDirs: [],
		topLevelDocs: [],
		// detectedRuntime is omitted.
	};

	const result = await proposeAgentsMd({ current: null, snapshot });

	expect(result.proposal).toContain("`unknown`");
});

// ---------------------------------------------------------------------------
// Test: Guard against huge repos (bounded at 40, 20, 30, etc.)
// ---------------------------------------------------------------------------

test("proposeAgentsMd: guards against huge root entries (capped at 40)", async () => {
	const snapshot = hugeSnapshot();
	// 60 entries total — should be capped at 40.

	const result = await proposeAgentsMd({ current: null, snapshot });

	// Count how many file- entries appear in the output.
	const match = result.proposal.match(/file-\d+/g);
	expect(match?.length ?? 0).toBeLessThanOrEqual(40);
});

test("proposeAgentsMd: guards against huge script list (capped at 20)", async () => {
	const snapshot = hugeSnapshot();
	// 30 scripts total — should be capped at 20.

	const result = await proposeAgentsMd({ current: null, snapshot });

	// Count how many script- entries appear in the output.
	const match = result.proposal.match(/script-\d+/g);
	expect(match?.length ?? 0).toBeLessThanOrEqual(20);
});

test("proposeAgentsMd: guards against huge test dirs (capped at 20)", async () => {
	const snapshot = hugeSnapshot();
	// 25 test dirs total — should be capped at 20.

	const result = await proposeAgentsMd({ current: null, snapshot });

	// Count how many test-dir- entries appear in the output.
	const match = result.proposal.match(/test-dir-\d+/g);
	expect(match?.length ?? 0).toBeLessThanOrEqual(20);
});

test("proposeAgentsMd: guards against huge doc list (capped at 30)", async () => {
	const snapshot = hugeSnapshot();
	// 35 docs total — should be capped at 30.

	const result = await proposeAgentsMd({ current: null, snapshot });

	// Count how many doc- entries appear in the output.
	const match = result.proposal.match(/doc-\d+/g);
	expect(match?.length ?? 0).toBeLessThanOrEqual(30);
});

// ---------------------------------------------------------------------------
// Test: Sanitization of untrusted input
// ---------------------------------------------------------------------------

test("proposeAgentsMd: sanitizes OUTPUT tags in snapshot strings (control-char aware)", async () => {
	const snapshot = injectionSnapshot();
	const result = await proposeAgentsMd({ current: null, snapshot });

	// The <output> tag should be escaped (sanitizeUntrusted targets ["output"] by default).
	expect(result.proposal).toContain("&lt;output>done&lt;/output>");

	// The </output> tag should be escaped.
	expect(result.proposal).toContain("&lt;/output>injected&lt;/output>");

	// The <script> tag is NOT escaped by sanitizeUntrusted (only "output" tags are).
	// But control chars WITHIN strings are stripped.
	expect(result.proposal).toContain("<script>alert('xss')</script>");
});

test("proposeAgentsMd: strips control characters from snapshot strings", async () => {
	// Create a snapshot with control chars in entry names.
	const snapshot: RepoSnapshot = {
		rootEntries: ["file\x00with\x01control\x02chars.txt"],
		scripts: {},
		testDirs: [],
		topLevelDocs: [],
		detectedRuntime: "bun",
	};

	const result = await proposeAgentsMd({ current: null, snapshot });

	// The string with control chars should have them stripped.
	const withoutCtrlChars = "filewithcontrolchars.txt";
	expect(result.proposal).toContain(withoutCtrlChars);

	// Verify the mangled version with literal control chars is NOT present.
	expect(result.proposal).not.toContain("file\x00with");
});

test("proposeAgentsMd: sanitization escapes OUTPUT tags and strips control chars", async () => {
	const snapshot: RepoSnapshot = {
		rootEntries: ["<output>evil</output>"],
		scripts: { "test": "<output>malicious</output>" },
		testDirs: ["<script>bad</script>"],
		topLevelDocs: ["</output>injection</output>"],
		detectedRuntime: "<data>runtime</data>",
	};

	const result = await proposeAgentsMd({ current: null, snapshot });

	// OUTPUT tags should be escaped in all fields (the sanitizeUntrusted targets "output").
	expect(result.proposal).toContain("&lt;output>evil&lt;/output>");
	expect(result.proposal).toContain("&lt;output>malicious&lt;/output>");
	expect(result.proposal).toContain("&lt;/output>injection&lt;/output>");

	// Other tags like <script> and <data> are NOT escaped by sanitizeUntrusted
	// (it only escapes the "output" tag by default), but control chars are stripped.
	expect(result.proposal).toContain("<script>bad</script>");
	expect(result.proposal).toContain("<data>runtime</data>");
});

// ---------------------------------------------------------------------------
// Test: LlmRefine hook (optional, fail-closed)
// ---------------------------------------------------------------------------

test("proposeAgentsMd: applies LlmRefine hook if provided", async () => {
	const snapshot = minimalSnapshot();

	const refine: LlmRefine = async (draft) => {
		// Simple test refine: append a marker.
		return draft + "\n\n<!-- refined -->";
	};

	const result = await proposeAgentsMd({ current: null, snapshot }, refine);

	expect(result.proposal).toContain("<!-- refined -->");
});

test("proposeAgentsMd: fail-closed when LlmRefine throws (uses deterministic)", async () => {
	const snapshot = minimalSnapshot();

	const badRefine: LlmRefine = async () => {
		throw new Error("Simulated LLM failure");
	};

	const result = await proposeAgentsMd({ current: null, snapshot }, badRefine);

	// Should fall back to the deterministic proposal (no error thrown).
	expect(result.proposal).toContain("<!-- nightshift:agents-md:begin -->");
	expect(result.proposal).toContain("## Runtime");

	// Should NOT contain any error marker.
	expect(result.proposal).not.toContain("Error");
});

test("proposeAgentsMd: LlmRefine can make changed=true even when snapshot is unchanged", async () => {
	const snapshot = minimalSnapshot();
	const proposal1 = await proposeAgentsMd({ current: null, snapshot });

	// Apply a refine that modifies the proposal.
	const refine: LlmRefine = async (draft) => {
		return draft + "\n\n# Added by LLM";
	};

	const proposal2 = await proposeAgentsMd(
		{ current: proposal1.proposal, snapshot },
		refine,
	);

	// Even though the snapshot is the same, the LLM changed the proposal.
	expect(proposal2.changed).toBe(true);
	expect(proposal2.proposal).toContain("Added by LLM");
});

test("proposeAgentsMd: LlmRefine is not called when no refine hook provided (identity)", async () => {
	const snapshot = minimalSnapshot();

	const result = await proposeAgentsMd({ current: null, snapshot });

	// Should succeed without an LLM.
	expect(result.changed).toBe(true);
	expect(result.proposal.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Test: Sections array accuracy
// ---------------------------------------------------------------------------

test("proposeAgentsMd: reports all sections in the returned array", async () => {
	const snapshot: RepoSnapshot = {
		rootEntries: ["src/"],
		scripts: { test: "bun test" },
		testDirs: ["src/__tests__/"],
		topLevelDocs: ["README.md"],
		detectedRuntime: "bun",
	};

	const result = await proposeAgentsMd({ current: null, snapshot });

	// Should include all possible section names.
	expect(result.sections).toContain("runtime");
	expect(result.sections).toContain("layout");
	expect(result.sections).toContain("key-dirs");
	expect(result.sections).toContain("scripts");
	expect(result.sections).toContain("test-dirs");
	expect(result.sections).toContain("docs");
	expect(result.sections).toContain("conventions");
});

test("proposeAgentsMd: omits sections that would be empty (test-dirs, docs), but includes scripts", async () => {
	const snapshot: RepoSnapshot = {
		rootEntries: ["src/"],
		scripts: {},
		testDirs: [], // Empty!
		topLevelDocs: [],
		detectedRuntime: "bun",
	};

	const result = await proposeAgentsMd({ current: null, snapshot });

	// test-dirs and docs should not be in sections if empty.
	expect(result.sections).not.toContain("test-dirs");
	expect(result.sections).not.toContain("docs");

	// But scripts, runtime, layout, and conventions should always be included.
	expect(result.sections).toContain("scripts");
	expect(result.sections).toContain("runtime");
	expect(result.sections).toContain("layout");
	expect(result.sections).toContain("conventions");
});

// ---------------------------------------------------------------------------
// Test: Idempotency
// ---------------------------------------------------------------------------

test("proposeAgentsMd: is idempotent (same snapshot → same proposal)", async () => {
	const snapshot = minimalSnapshot();

	const result1 = await proposeAgentsMd({ current: null, snapshot });
	const result2 = await proposeAgentsMd({ current: null, snapshot });

	expect(result1.proposal).toEqual(result2.proposal);
	expect(result1.sections).toEqual(result2.sections);
});

test("mergeManagedBlock: is idempotent (same block → same result)", () => {
	const current = "Before\n<!-- nightshift:agents-md:begin -->\nOld\n<!-- :end -->\nAfter";
	const block = "<!-- nightshift:agents-md:begin -->\nNew\n<!-- :end -->";

	const result1 = mergeManagedBlock(current, block);
	const result2 = mergeManagedBlock(result1, block);

	expect(result1).toEqual(result2);
});

// ---------------------------------------------------------------------------
// Test: Complex scenarios
// ---------------------------------------------------------------------------

test("proposeAgentsMd: handles a realistic project snapshot", async () => {
	const snapshot: RepoSnapshot = {
		rootEntries: [
			"src/",
			"test/",
			"docs/",
			"package.json",
			"tsconfig.json",
			"README.md",
			"CONTRIBUTING.md",
			".gitignore",
		],
		scripts: {
			dev: "bun run --watch src/index.ts",
			test: "bun test",
			build: "tsc",
			lint: "eslint src/",
		},
		testDirs: ["test/", "src/__tests__/"],
		topLevelDocs: ["README.md", "CONTRIBUTING.md", "docs/ARCHITECTURE.md"],
		detectedRuntime: "bun",
	};

	const result = await proposeAgentsMd({ current: null, snapshot });

	// Verify structure.
	expect(result.changed).toBe(true);
	expect(result.sections.length).toBeGreaterThan(0);

	// Verify content.
	expect(result.proposal).toContain("## Runtime");
	expect(result.proposal).toContain("`bun`");
	expect(result.proposal).toContain("## Project Layout");
	expect(result.proposal).toContain("package.json");
	expect(result.proposal).toContain("## Scripts");
	expect(result.proposal).toContain("`dev`");
	expect(result.proposal).toContain("## Test Directories");
	expect(result.proposal).toContain("## Documentation");
	expect(result.proposal).toContain("## Conventions");
	expect(result.proposal).toContain("explicit `.ts` extensions");
});

test("proposeAgentsMd: complex merge with interleaved hand-written sections", async () => {
	const handWritten = `# Project Guide

## Custom Introduction
This is a hand-written custom intro that the agents should see.

<!-- nightshift:agents-md:begin -->
old managed block
<!-- :end -->

## Custom Conclusion
This is a hand-written custom conclusion.

More details about the project...
`;

	const snapshot = minimalSnapshot();
	const result = await proposeAgentsMd({ current: handWritten, snapshot });

	// All hand-written sections should remain.
	expect(result.proposal).toContain("Custom Introduction");
	expect(result.proposal).toContain("Custom Conclusion");
	expect(result.proposal).toContain("More details about the project");

	// Old managed block should be replaced.
	expect(result.proposal).not.toContain("old managed block");

	// New managed block should exist.
	expect(result.proposal).toContain("<!-- nightshift:agents-md:begin -->");

	// Check the order: intro, managed, conclusion.
	const introIdx = result.proposal.indexOf("Custom Introduction");
	const managedIdx = result.proposal.indexOf("<!-- nightshift:agents-md:begin -->");
	const conclusionIdx = result.proposal.indexOf("Custom Conclusion");

	expect(introIdx).toBeLessThan(managedIdx);
	expect(managedIdx).toBeLessThan(conclusionIdx);
});

// ---------------------------------------------------------------------------
// Test: FAIL-CLOSED — secrets/tokens never in error payloads
// ---------------------------------------------------------------------------

test("proposeAgentsMd: LlmRefine error message is NOT echoed into the proposal (secrets safe)", async () => {
	const snapshot = minimalSnapshot();

	// A refine that throws an error containing a fake secret/token.
	const secretToken = "sk-secret-token-MUST-NOT-APPEAR";
	const badRefine: LlmRefine = async () => {
		throw new Error(`API error with token ${secretToken}`);
	};

	const result = await proposeAgentsMd({ current: null, snapshot }, badRefine);

	// Fail-closed: falls back to deterministic proposal.
	expect(result.proposal).toContain("<!-- nightshift:agents-md:begin -->");

	// CRITICAL: the error message (including any secret) must NOT appear in the proposal.
	expect(result.proposal).not.toContain(secretToken);
	expect(result.proposal).not.toContain("API error with token");
});

// ---------------------------------------------------------------------------
// Test: Route-level — agentsMdRoutes (project_not_found, happy path, bad id)
// ---------------------------------------------------------------------------

describe("agentsMdRoutes: GET /projects/:id/agents-md/proposal", () => {
	test("returns 200 with proposal for an existing project", async () => {
		const id = seedProject("my-project");

		const { status, body } = await callRoute("/projects/:id/agents-md/proposal", {
			id: String(id),
		});

		expect(status).toBe(200);
		const typed = body as { project_id: number; proposal: string; changed: boolean; sections: string[]; note: string };
		expect(typed.project_id).toBe(id);
		expect(typed.changed).toBe(true);
		expect(typeof typed.note).toBe("string");
		expect(typed.proposal).toContain("<!-- nightshift:agents-md:begin -->");
		expect(typed.sections.length).toBeGreaterThan(0);
		// The note must mention host-scan / GATE-5 so callers know the limitation.
		expect(typed.note).toMatch(/GATE-5|host.*scan|scan.*host/i);
	});

	test("returns 404 (project_not_found) when project does not exist", async () => {
		const { status, body } = await callRoute("/projects/:id/agents-md/proposal", {
			id: "99999",
		});

		expect(status).toBe(404);
		const typed = body as { error: { code: string; message: string } };
		expect(typed.error.code).toBe("not_found");
	});

	test("returns 400 (bad_request) for a non-integer project id", async () => {
		const { status, body } = await callRoute("/projects/:id/agents-md/proposal", {
			id: "not-a-number",
		});

		expect(status).toBe(400);
		const typed = body as { error: { code: string } };
		expect(typed.error.code).toBe("bad_request");
	});

	test("returns 400 (bad_request) for zero project id (non-positive)", async () => {
		const { status, body } = await callRoute("/projects/:id/agents-md/proposal", {
			id: "0",
		});

		expect(status).toBe(400);
		const typed = body as { error: { code: string } };
		expect(typed.error.code).toBe("bad_request");
	});

	test("proposal body never contains secrets or raw error messages (fail-closed)", async () => {
		const id = seedProject();

		const { status, body } = await callRoute("/projects/:id/agents-md/proposal", {
			id: String(id),
		});

		expect(status).toBe(200);
		const typed = body as { proposal: string };
		// No token patterns or error stack traces in the proposal.
		expect(typed.proposal).not.toMatch(/sk-[a-zA-Z0-9-]+/);
		expect(typed.proposal).not.toContain("Error:");
		expect(typed.proposal).not.toContain("at Object.");
	});

	test("route is registered as GET with auth=true in agentsMdRoutes", () => {
		const route = agentsMdRoutes.find(
			(r) => r.path === "/projects/:id/agents-md/proposal" && r.method === "GET",
		);

		expect(route).toBeDefined();
		expect(route?.auth).toBe(true);
	});
});
