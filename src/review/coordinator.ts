/**
 * WHY: The coordinator (BLUEPRINT §3.4) is the triage stage the specialist
 * finders deliberately skip. Six recall-first finders produce a noisy union
 * with overlaps (two finders flag the same line) and low-confidence guesses.
 * The coordinator (a) collapses duplicates keeping the strongest signal,
 * (b) optionally hands low-confidence findings to an adversarial verifier that
 * can drop or downgrade them, and (c) applies ONE approval-biased rubric so a
 * pile of nits can never block a merge — only a real critical/high with
 * meaningful confidence does.
 *
 * Pure & deterministic given `verifyProducer`: same findings + same verifier
 * answers ⇒ same verdict. No clock, no DB, no IO of its own.
 */

import { FINDING_SEVERITIES, type FindingSeverity } from "../db/columns.ts";
import type { FinderFinding } from "./specialists.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CoordinatorVerdict = "approve" | "approve_with_comments" | "block";

export interface CoordinatorResult {
	verdict: CoordinatorVerdict;
	summary: string;
	findings: FinderFinding[];
}

export interface CoordinatorInput {
	findings: FinderFinding[];
	/**
	 * Adversarial verifier for low-confidence findings. keep=false drops the
	 * finding; a returned severity downgrades it. Absent ⇒ no verification pass.
	 */
	verifyProducer?: (f: FinderFinding) => Promise<{ keep: boolean; severity?: FindingSeverity }>;
}

// ---------------------------------------------------------------------------
// Severity ordering — strongest first for merge/blocking decisions
// ---------------------------------------------------------------------------

/** Rank severities high→low; FINDING_SEVERITIES is [critical,high,medium,low,nit]. */
const SEVERITY_RANK: Record<FindingSeverity, number> = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
	nit: 0,
};

/** True when `a` is at least as severe as `b`. */
function severityGte(a: FindingSeverity, b: FindingSeverity): boolean {
	return SEVERITY_RANK[a] >= SEVERITY_RANK[b];
}

// ---------------------------------------------------------------------------
// Dedup + merge near-duplicates
// ---------------------------------------------------------------------------

/** Collapse whitespace + lowercase so trivially-reworded dups match. */
function normalizeDescription(d: string): string {
	return d.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Dedup key: same file + same line + same normalized description. */
function dedupKey(f: FinderFinding): string {
	return `${f.file}::${f.line ?? "-"}::${normalizeDescription(f.description)}`;
}

/**
 * Merge two findings flagged as the same issue: keep the higher severity, and
 * (independently) the higher confidence — so the surviving record carries the
 * strongest signal either finder produced. The first finding's kind/file/line/
 * description are retained as the canonical identity.
 */
function mergeFindings(into: FinderFinding, other: FinderFinding): FinderFinding {
	const severity = severityGte(into.severity, other.severity) ? into.severity : other.severity;
	const confidence = Math.max(into.confidence, other.confidence);
	const merged: FinderFinding = { ...into, severity, confidence };
	if (merged.suggestion === undefined && other.suggestion !== undefined) {
		merged.suggestion = other.suggestion;
	}
	return merged;
}

/** Dedup by (file,line,normalized-description), merging near-duplicates. */
function dedup(findings: FinderFinding[]): FinderFinding[] {
	const byKey = new Map<string, FinderFinding>();
	const order: string[] = [];
	for (const f of findings) {
		const key = dedupKey(f);
		const existing = byKey.get(key);
		if (existing === undefined) {
			byKey.set(key, f);
			order.push(key);
		} else {
			byKey.set(key, mergeFindings(existing, f));
		}
	}
	return order.map((k) => byKey.get(k)!);
}

// ---------------------------------------------------------------------------
// Adversarial verification of low-confidence findings
// ---------------------------------------------------------------------------

const LOW_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Run the verifier over every finding with confidence < 0.6. A finding the
 * verifier says !keep is dropped; a returned severity is applied as a downgrade
 * (we never let the verifier ESCALATE — it only prunes/softens, fail-safe
 * toward approval). High-confidence findings pass through untouched.
 */
async function verifyLowConfidence(
	findings: FinderFinding[],
	verifyProducer: NonNullable<CoordinatorInput["verifyProducer"]>,
): Promise<FinderFinding[]> {
	const kept: FinderFinding[] = [];
	for (const f of findings) {
		if (f.confidence >= LOW_CONFIDENCE_THRESHOLD) {
			kept.push(f);
			continue;
		}
		const decision = await verifyProducer(f);
		if (!decision.keep) continue; // verifier rejected it.
		if (decision.severity !== undefined && !severityGte(decision.severity, f.severity)) {
			// Apply the downgrade only (verifier may soften, never escalate).
			kept.push({ ...f, severity: decision.severity });
		} else {
			kept.push(f);
		}
	}
	return kept;
}

// ---------------------------------------------------------------------------
// Approval-biased rubric
// ---------------------------------------------------------------------------

/**
 * Block IFF any surviving finding is `critical`, OR `high` with confidence
 * >= 0.6. Otherwise approve_with_comments when anything survives, else approve.
 */
function decideVerdict(findings: FinderFinding[]): CoordinatorVerdict {
	const blocking = findings.some(
		(f) =>
			f.severity === "critical" ||
			(f.severity === "high" && f.confidence >= LOW_CONFIDENCE_THRESHOLD),
	);
	if (blocking) return "block";
	return findings.length > 0 ? "approve_with_comments" : "approve";
}

/** Human-readable one-liner summarizing the surviving finding mix. */
function summarize(verdict: CoordinatorVerdict, findings: FinderFinding[]): string {
	if (findings.length === 0) return "No findings survived coordination — approved.";
	const counts = FINDING_SEVERITIES.map((sev) => {
		const n = findings.filter((f) => f.severity === sev).length;
		return n > 0 ? `${n} ${sev}` : null;
	}).filter((s): s is string => s !== null);
	const mix = counts.join(", ");
	if (verdict === "block") return `Blocking: ${mix}.`;
	return `Approved with comments: ${mix}.`;
}

// ---------------------------------------------------------------------------
// coordinate — the public entry point
// ---------------------------------------------------------------------------

/**
 * Dedup the finder union, optionally adversarially verify low-confidence
 * findings, then apply the approval-biased rubric. Pure & deterministic given
 * `verifyProducer`.
 */
export async function coordinate(input: CoordinatorInput): Promise<CoordinatorResult> {
	const deduped = dedup(input.findings);
	const survivors =
		input.verifyProducer === undefined
			? deduped
			: await verifyLowConfidence(deduped, input.verifyProducer);
	const verdict = decideVerdict(survivors);
	return { verdict, summary: summarize(verdict, survivors), findings: survivors };
}
