/**
 * WHY: Cloudflare-style review depth tiers (BLUEPRINT §3.4). A PR is not worth
 * the same review effort regardless of size: a one-line typo fix and a rewrite
 * of the egress sandbox both burning six specialist reviewers wastes budget AND
 * floods the coordinator with noise. This module is the SOLE pure classifier
 * that turns a unified diff into a {trivial|lite|full} tier plus the security
 * signal that overrides everything.
 *
 * Two hardening rules ride on top of raw size:
 *   - `declaredTier` is a FLOOR — a task author can ask for MORE review than the
 *     size implies, never less. We escalate, never de-escalate, a declared tier.
 *   - `securityTouched` forces "full" unconditionally. Auth/crypto/secret/egress/
 *     sandbox/forge paths get every specialist no matter how small the diff —
 *     fail-closed: when in doubt about security surface, review harder.
 *
 * noiseFilter drops machine-generated churn (lockfiles, *.min.*, *.snap) BEFORE
 * sizing so a regenerated lockfile can't inflate a trivial change into a full
 * review — but it deliberately KEEPS drizzle/*.sql migrations, which are exactly
 * the kind of generated-looking file that still demands human-grade review.
 *
 * Pure & deterministic: no clock, no DB, no IO. Same diff in ⇒ same tier out.
 */

import type { RiskTier } from "../db/columns.ts";
import type { SpecialistKind } from "./specialists.ts";

// ---------------------------------------------------------------------------
// noiseFilter — drop machine-generated churn from the changed-file set
// ---------------------------------------------------------------------------

/** Exact lockfile basenames that never warrant review. */
const LOCKFILES = new Set([
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
]);

/** Generated/minified suffix patterns dropped from review. */
const GENERATED_SUFFIXES = [".min.js", ".min.css", ".snap"];

/** Migrations look generated but MUST be reviewed (DDL is high-blast-radius). */
function isMigration(path: string): boolean {
	return /(?:^|\/)drizzle\/.*\.sql$/.test(path);
}

function basename(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? path : path.slice(i + 1);
}

/** True when `path` is machine-generated churn we should not spend review on. */
function isNoise(path: string): boolean {
	if (isMigration(path)) return false; // migrations always kept.
	if (LOCKFILES.has(basename(path))) return true;
	return GENERATED_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/**
 * Strip a leading a/ or b/ prefix and ignore the /dev/null sentinel. Returns
 * null when the header carries no real path (added/deleted side of a rename).
 */
function normalizeHeaderPath(raw: string): string | null {
	const p = raw.trim();
	if (p === "" || p === "/dev/null") return null;
	return p.replace(/^[ab]\//, "");
}

/**
 * Parse every changed file path out of a unified diff. We read "diff --git",
 * "+++" and "---" headers and union the paths (a pure add only has +++, a pure
 * delete only has ---). Deduped, order-preserving.
 */
function changedFilePaths(diff: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	const add = (p: string | null): void => {
		if (p !== null && !seen.has(p)) {
			seen.add(p);
			out.push(p);
		}
	};
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			// `diff --git a/foo b/foo` — take both sides (handles renames/copies).
			const rest = line.slice("diff --git ".length).trim();
			const m = /^(\S+)\s+(\S+)$/.exec(rest);
			if (m) {
				add(normalizeHeaderPath(m[1] ?? ""));
				add(normalizeHeaderPath(m[2] ?? ""));
			}
			continue;
		}
		if (line.startsWith("+++ ")) {
			add(normalizeHeaderPath(line.slice(4)));
			continue;
		}
		if (line.startsWith("--- ")) {
			add(normalizeHeaderPath(line.slice(4)));
			continue;
		}
	}
	return out;
}

/**
 * Split the diff's changed files into kept (reviewable) and dropped (generated
 * churn). Lockfiles, *.min.js/css and *.snap are dropped; drizzle/*.sql
 * migrations are always kept.
 */
export function noiseFilter(diff: string): { keptFiles: string[]; droppedFiles: string[] } {
	const keptFiles: string[] = [];
	const droppedFiles: string[] = [];
	for (const path of changedFilePaths(diff)) {
		if (isNoise(path)) droppedFiles.push(path);
		else keptFiles.push(path);
	}
	return { keptFiles, droppedFiles };
}

// ---------------------------------------------------------------------------
// securityTouched — does the change touch a security-sensitive surface?
// ---------------------------------------------------------------------------

/**
 * Path substrings that flag a security-sensitive surface (§3.4). Matched
 * case-insensitively against the full normalized path so e.g. `src/egress/…`,
 * `…/auth.ts`, `cryptoUtil.ts`, `forge/github.ts`, `sandbox/run.ts` all trip.
 */
const SECURITY_PATTERNS = [
	"auth",
	"crypto",
	"secret",
	"token",
	"password",
	"egress",
	"sandbox",
	"forge",
	"credential",
];

/** True when ANY file path matches a security-sensitive pattern. */
export function securityTouched(files: string[]): boolean {
	return files.some((f) => {
		const lower = f.toLowerCase();
		return SECURITY_PATTERNS.some((pat) => lower.includes(pat));
	});
}

// ---------------------------------------------------------------------------
// classifyRiskTier — size + security + declared floor ⇒ tier
// ---------------------------------------------------------------------------

/** Count added/removed body lines (not the +++/--- file headers) in the diff. */
function changedLineCount(diff: string): number {
	let count = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue; // file headers.
		if (line.startsWith("+") || line.startsWith("-")) count++;
	}
	return count;
}

/** Order tiers low→high so `declaredTier` can act as a monotonic floor. */
const TIER_RANK: Record<RiskTier, number> = { trivial: 0, lite: 1, full: 2 };

/** Return whichever tier is higher-ranked (used to apply the declared floor). */
function maxTier(a: RiskTier, b: RiskTier): RiskTier {
	return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/** Trivial threshold: tiny change across very few non-security files. */
const TRIVIAL_MAX_LINES = 10;
const TRIVIAL_MAX_FILES = 2;
/** Lite/full boundary on raw changed-line size. */
const LITE_MAX_LINES = 200;

export interface RiskTierResult {
	tier: RiskTier;
	changedFiles: string[];
	securityTouched: boolean;
	reason: string;
}

/**
 * Classify a diff into a review tier (§3.4):
 *   trivial — ≤10 changed lines across ≤2 non-security kept files.
 *   lite    — small/moderate (anything not trivial and not full).
 *   full    — large (>200 changed lines) OR security-touched.
 * `declaredTier` raises the floor (never lowers); securityTouched forces "full".
 */
export function classifyRiskTier(input: {
	diff: string;
	declaredTier?: RiskTier;
}): RiskTierResult {
	const { keptFiles } = noiseFilter(input.diff);
	const security = securityTouched(keptFiles);
	const lines = changedLineCount(input.diff);

	let tier: RiskTier;
	let reason: string;

	if (security) {
		tier = "full";
		reason = "security-sensitive paths touched → full review";
	} else if (lines > LITE_MAX_LINES) {
		tier = "full";
		reason = `large change (${lines} changed lines) → full review`;
	} else if (lines <= TRIVIAL_MAX_LINES && keptFiles.length <= TRIVIAL_MAX_FILES) {
		tier = "trivial";
		reason = `tiny change (${lines} lines, ${keptFiles.length} files) → trivial review`;
	} else {
		tier = "lite";
		reason = `moderate change (${lines} lines, ${keptFiles.length} files) → lite review`;
	}

	// declaredTier is a FLOOR: escalate to it, never below it.
	if (input.declaredTier !== undefined && TIER_RANK[input.declaredTier] > TIER_RANK[tier]) {
		const floored = maxTier(tier, input.declaredTier);
		reason = `${reason}; raised to declared floor "${input.declaredTier}"`;
		tier = floored;
	}

	return { tier, changedFiles: keptFiles, securityTouched: security, reason };
}

// ---------------------------------------------------------------------------
// reviewersForTier / coordinatorForTier — the per-tier specialist roster
// ---------------------------------------------------------------------------

/**
 * The specialist roster per tier (§3.4). trivial spends only the two cheapest,
 * highest-value finders; full runs the entire bench. Order is stable so the
 * harness fans out deterministically.
 */
export function reviewersForTier(tier: RiskTier): SpecialistKind[] {
	switch (tier) {
		case "trivial":
			return ["correctness", "security"];
		case "lite":
			return ["correctness", "security", "quality"];
		case "full":
			return ["security", "correctness", "performance", "quality", "docs", "agents_md"];
	}
}

/**
 * Whether to run the coordinator pass for a tier. trivial skips the coordinator
 * (the harness still applies the approval rubric over the finder union); lite/
 * full coordinate (dedup + adversarial verify of low-confidence findings).
 */
export function coordinatorForTier(tier: RiskTier): boolean {
	return tier !== "trivial";
}
