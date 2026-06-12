/**
 * WHY: The verdict JSON schema + hand-rolled validator (PHASE3-CONTRACT §4.1).
 * `extractStructured` yields `unknown`; this is the ONLY gate that turns it
 * into a typed Verdict. FAIL-CLOSED: any violation returns {ok:false, reason}
 * — a parse/validation failure can never become an "approved" verdict.
 * Unknown extra keys are ignored by rebuilding a clean object from validated
 * fields only.
 */

import { FINDING_RESOLUTION_STATES, FINDING_SEVERITIES } from "../db/columns.ts";
import type { FindingResolutionState, FindingSeverity } from "../db/columns.ts";

export interface VerdictFinding {
	file: string; // non-empty
	line?: number; // integer ≥ 1
	severity: FindingSeverity; // "critical"|"high"|"medium"|"low"|"nit"
	confidence: number; // 0..1 inclusive
	description: string; // non-empty
	suggestion?: string;
}

export interface VerdictResolution {
	finding_id: number; // findings.id from a prior round
	state: Exclude<FindingResolutionState, "open">; // fixed|rebutted|withdrawn|accepted_risk
}

export interface Verdict {
	verdict: "approved" | "revise";
	summary: string; // non-empty
	findings: VerdictFinding[]; // NEW findings this round (may be [])
	resolutions?: VerdictResolution[]; // delta rounds (r≥2): one per prior open/rebutted finding
}

export type ValidateResult = { ok: true; verdict: Verdict } | { ok: false; reason: string };

type Fail = { ok: false; reason: string };

function fail(reason: string): Fail {
	return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateFinding(value: unknown, i: number): { ok: true; finding: VerdictFinding } | Fail {
	if (!isRecord(value)) return fail(`findings[${i}] must be an object`);
	const { file, line, severity, confidence, description, suggestion } = value;
	if (typeof file !== "string" || file === "") {
		return fail(`findings[${i}].file must be a non-empty string`);
	}
	if (line !== undefined && (typeof line !== "number" || !Number.isInteger(line) || line < 1)) {
		return fail(`findings[${i}].line must be an integer >= 1 when present`);
	}
	if (typeof severity !== "string" || !(FINDING_SEVERITIES as readonly string[]).includes(severity)) {
		return fail(`findings[${i}].severity must be one of ${FINDING_SEVERITIES.join("|")}`);
	}
	if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) {
		return fail(`findings[${i}].confidence must be a number in 0..1`);
	}
	if (typeof description !== "string" || description === "") {
		return fail(`findings[${i}].description must be a non-empty string`);
	}
	if (suggestion !== undefined && typeof suggestion !== "string") {
		return fail(`findings[${i}].suggestion must be a string when present`);
	}
	const finding: VerdictFinding = {
		file,
		severity: severity as FindingSeverity,
		confidence,
		description,
	};
	if (line !== undefined) finding.line = line as number;
	if (suggestion !== undefined) finding.suggestion = suggestion;
	return { ok: true, finding };
}

function validateResolution(
	value: unknown,
	i: number,
): { ok: true; resolution: VerdictResolution } | Fail {
	if (!isRecord(value)) return fail(`resolutions[${i}] must be an object`);
	const { finding_id, state } = value;
	if (typeof finding_id !== "number" || !Number.isInteger(finding_id) || finding_id < 1) {
		return fail(`resolutions[${i}].finding_id must be an integer >= 1`);
	}
	if (
		typeof state !== "string" ||
		state === "open" ||
		!(FINDING_RESOLUTION_STATES as readonly string[]).includes(state)
	) {
		return fail(`resolutions[${i}].state must be one of fixed|rebutted|withdrawn|accepted_risk`);
	}
	return {
		ok: true,
		resolution: { finding_id, state: state as Exclude<FindingResolutionState, "open"> },
	};
}

/**
 * Validate an unknown value against the Verdict schema. Exact enum membership,
 * exact types, unknown extra keys ignored, ANY violation ⇒ {ok:false, reason}.
 */
export function validateVerdict(value: unknown): ValidateResult {
	if (!isRecord(value)) return fail("verdict must be a JSON object");

	const verdict = value.verdict;
	if (verdict !== "approved" && verdict !== "revise") {
		return fail('verdict must be "approved" or "revise"');
	}

	const summary = value.summary;
	if (typeof summary !== "string" || summary.trim() === "") {
		return fail("summary must be a non-empty string");
	}

	const rawFindings = value.findings;
	if (!Array.isArray(rawFindings)) return fail("findings must be an array");
	const findings: VerdictFinding[] = [];
	for (let i = 0; i < rawFindings.length; i++) {
		const r = validateFinding(rawFindings[i], i);
		if (!r.ok) return r;
		findings.push(r.finding);
	}

	const out: Verdict = { verdict, summary, findings };

	const rawResolutions = value.resolutions;
	if (rawResolutions !== undefined) {
		if (!Array.isArray(rawResolutions)) return fail("resolutions must be an array when present");
		const resolutions: VerdictResolution[] = [];
		for (let i = 0; i < rawResolutions.length; i++) {
			const r = validateResolution(rawResolutions[i], i);
			if (!r.ok) return r;
			resolutions.push(r.resolution);
		}
		out.resolutions = resolutions;
	}

	return { ok: true, verdict: out };
}
