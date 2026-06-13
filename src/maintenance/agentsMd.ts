/**
 * WHY: Keeps a project's AGENTS.md (the agent-facing repo guide) up to date
 * from repo structure (BLUEPRINT §3 "AGENTS.md auto-maintenance"). The module
 * is PURE + injectable — no real FS access; the caller scans the repo and
 * passes a RepoSnapshot, tests pass a fake. A MARKER-delimited managed block
 * (<!-- nightshift:agents-md:begin --> ... <!-- :end -->) is inserted/replaced
 * deterministically; hand-written prose outside the block is preserved.
 *
 * Snapshot strings are treated as untrusted data: sanitizeUntrusted() from
 * src/review/sanitize.ts strips control chars and escapes output-envelope tags
 * before any value enters the generated markdown.
 *
 * The optional LlmRefine hook is injected by callers that want to post-process
 * the deterministic proposal; defaults to the identity function so the module
 * never requires a live LLM and tests pass without one.
 */

import { sanitizeUntrusted } from "../review/sanitize.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A caller-supplied snapshot of the repo's observable structure.
 * Tests pass a fake; the host/GATE-5 side scans the real FS.
 */
export interface RepoSnapshot {
	/** Top-level directory / file entries (ls of repo root). */
	rootEntries: string[];
	/** package.json / pyproject.toml / Makefile scripts — name → command. */
	scripts: Record<string, string>;
	/** Directories that contain tests (detected by name or convention). */
	testDirs: string[];
	/** Top-level documentation files (*.md, docs/**). */
	topLevelDocs: string[];
	/** Detected runtime: "bun", "node", "python", "go", … (optional). */
	detectedRuntime?: string;
}

/** Injectable LLM refine hook. Receives the deterministic proposal; returns a refined version. */
export type LlmRefine = (draft: string) => Promise<string>;

/** Result of proposeAgentsMd. */
export interface AgentsMdProposal {
	/** The full proposed AGENTS.md content (with managed block merged in). */
	proposal: string;
	/** false when `current` already contains an identical managed block. */
	changed: boolean;
	/** Names of sections regenerated inside the managed block. */
	sections: string[];
}

// ---------------------------------------------------------------------------
// Marker constants
// ---------------------------------------------------------------------------

const BLOCK_BEGIN = "<!-- nightshift:agents-md:begin -->";
const BLOCK_END = "<!-- :end -->";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Sanitize a single string from a snapshot (treat as untrusted data). */
function sanitize(value: string): string {
	return sanitizeUntrusted(value, { tags: ["output"] });
}

/**
 * Build the managed block content (everything between the markers, exclusive).
 * Returns { body, sections }.
 */
function buildManagedContent(snapshot: RepoSnapshot): { body: string; sections: string[] } {
	const sections: string[] = [];
	const lines: string[] = [];

	// -- Runtime / language -----------------------------------------------
	sections.push("runtime");
	const runtime = snapshot.detectedRuntime
		? sanitize(snapshot.detectedRuntime)
		: "unknown";
	lines.push(`## Runtime\n\n\`${runtime}\``);

	// -- Project layout ---------------------------------------------------
	sections.push("layout");
	const safeEntries = snapshot.rootEntries
		.slice(0, 40) // guard against huge repos
		.map((e) => sanitize(e))
		.filter((e) => e.length > 0);
	if (safeEntries.length > 0) {
		lines.push(`\n## Project Layout\n\n\`\`\`\n${safeEntries.join("\n")}\n\`\`\``);
	}

	// -- Key directories --------------------------------------------------
	const keyDirs = safeEntries.filter((e) => !e.includes(".") || e.startsWith("src"));
	if (keyDirs.length > 0) {
		sections.push("key-dirs");
		const dirList = keyDirs.map((d) => `- \`${d}\``).join("\n");
		lines.push(`\n## Key Directories\n\n${dirList}`);
	}

	// -- How to run / test ------------------------------------------------
	sections.push("scripts");
	const scriptEntries = Object.entries(snapshot.scripts)
		.slice(0, 20)
		.map(([name, cmd]) => `- \`${sanitize(name)}\`: \`${sanitize(cmd)}\``);
	if (scriptEntries.length > 0) {
		lines.push(`\n## Scripts\n\n${scriptEntries.join("\n")}`);
	}

	// -- Test directories -------------------------------------------------
	if (snapshot.testDirs.length > 0) {
		sections.push("test-dirs");
		const safeDirs = snapshot.testDirs
			.slice(0, 20)
			.map((d) => `- \`${sanitize(d)}\``)
			.join("\n");
		lines.push(`\n## Test Directories\n\n${safeDirs}`);
	}

	// -- Documentation ----------------------------------------------------
	if (snapshot.topLevelDocs.length > 0) {
		sections.push("docs");
		const safeDocs = snapshot.topLevelDocs
			.slice(0, 30)
			.map((d) => `- \`${sanitize(d)}\``)
			.join("\n");
		lines.push(`\n## Documentation\n\n${safeDocs}`);
	}

	// -- Conventions ------------------------------------------------------
	sections.push("conventions");
	const conventionLines: string[] = [
		"- Use explicit `.ts` extensions for ESM imports.",
		"- All DB writes go through `enqueueWrite()` (serialized writer queue).",
		"- Reads are direct (WAL mode; no reader lock).",
		"- Every module with side-effects exposes a `Deps` interface for injection.",
		"- Timestamps: `new Date().toISOString()`.",
		"- Tests: `bun:test`, per-test in-memory DB via `openDatabase(':memory:')`.",
	];
	lines.push(`\n## Conventions\n\n${conventionLines.join("\n")}`);

	const body = lines.join("\n");
	return { body, sections };
}

/**
 * Extract the current managed block body from `current`, or null if absent.
 * Returns null when there is no begin/end pair.
 */
function extractManagedBody(current: string): string | null {
	const beginIdx = current.indexOf(BLOCK_BEGIN);
	if (beginIdx === -1) return null;
	const endIdx = current.indexOf(BLOCK_END, beginIdx + BLOCK_BEGIN.length);
	if (endIdx === -1) return null;
	return current.slice(beginIdx + BLOCK_BEGIN.length, endIdx);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deterministically build a proposed AGENTS.md from the snapshot.
 * If `current` already contains an up-to-date generated block, changed=false.
 * The LlmRefine hook (if provided) is applied after the deterministic proposal;
 * defaults to identity so the module works without an LLM.
 */
export async function proposeAgentsMd(
	input: { current: string | null; snapshot: RepoSnapshot },
	llmRefine?: LlmRefine,
): Promise<AgentsMdProposal> {
	const { current, snapshot } = input;
	const { body: managedBody, sections } = buildManagedContent(snapshot);
	const managedBlock = `${BLOCK_BEGIN}\n${managedBody}\n${BLOCK_END}`;

	// Determine if the current content already matches.
	const existingBody = current !== null ? extractManagedBody(current) : null;
	const alreadyCurrent =
		existingBody !== null && existingBody === `\n${managedBody}\n`;

	// Merge the managed block into the current content.
	const merged = mergeManagedBlock(current, managedBlock);

	// Apply LLM refine (fail-closed: if it throws, fall back to deterministic).
	let proposal = merged;
	if (llmRefine !== undefined) {
		try {
			proposal = await llmRefine(merged);
		} catch {
			// Fail-closed: use the deterministic proposal.
			proposal = merged;
		}
	}

	const changed = !alreadyCurrent || proposal !== merged;

	return { proposal, changed, sections };
}

/**
 * Insert or replace ONLY the managed block in `current`, preserving all prose
 * outside the markers. When `current` is null or has no existing block, the
 * managed block is appended. When a block is found, it is replaced in-place.
 */
export function mergeManagedBlock(current: string | null, managed: string): string {
	const base = current ?? "";
	const beginIdx = base.indexOf(BLOCK_BEGIN);
	const endIdx =
		beginIdx !== -1 ? base.indexOf(BLOCK_END, beginIdx + BLOCK_BEGIN.length) : -1;

	if (beginIdx !== -1 && endIdx !== -1) {
		// Replace the existing block (inclusive of both markers).
		const before = base.slice(0, beginIdx);
		const after = base.slice(endIdx + BLOCK_END.length);
		return `${before}${managed}${after}`;
	}

	// No existing block — append with a blank-line separator.
	if (base.length === 0) return managed;
	const separator = base.endsWith("\n\n") ? "" : base.endsWith("\n") ? "\n" : "\n\n";
	return `${base}${separator}${managed}`;
}
