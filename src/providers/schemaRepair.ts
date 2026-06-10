/**
 * Structured-output trust boundary for CLI drivers (BLUEPRINT §3.9).
 *
 * CLI drivers emit JSON wrapped in an XML envelope (<output>…</output> by
 * default). This module is the ONLY path from raw stdout to parsed data.
 * It is intentionally FAIL-CLOSED: if nothing valid is extractable, it returns
 * `ok:false` — it NEVER fabricates a default value.
 *
 * Two-pass extraction:
 *   1. Pull the LAST matching tag block (later output wins over earlier noise).
 *   2. Strip common markdown-fence wrapping and trailing prose before parsing.
 *
 * The result is `unknown` — callers must validate the shape themselves.
 */

/** Matches the last occurrence of <tag>…</tag> (non-greedy, dotAll). */
function extractTagBlock(stdout: string, tag: string): string | null {
	// Build a regex that finds the LAST matching pair.
	// Using a global search and keeping the final match.
	const pattern = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "g");
	let last: RegExpExecArray | null = null;
	let m: RegExpExecArray | null;
	while ((m = pattern.exec(stdout)) !== null) {
		last = m;
	}
	if (last === null) return null;
	const openLen = tag.length + 2; // `<tag>`
	const closeLen = tag.length + 3; // `</tag>`
	return last[0].slice(openLen, last[0].length - closeLen);
}

/** Strip markdown code fences and anything after the closing `}` or `]`. */
function repairFences(raw: string): string {
	// Remove ```json ... ``` or ``` ... ``` wrappers.
	let s = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
	s = s.trim();
	// Truncate trailing prose after the last `}` or `]`.
	const lastBrace = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
	if (lastBrace !== -1) {
		s = s.slice(0, lastBrace + 1);
	}
	return s;
}

export type ExtractResult =
	| { ok: true; value: unknown }
	| { ok: false; reason: string };

/**
 * Extract and parse a JSON value from the last `<tag>…</tag>` block in stdout.
 *
 * @param stdout - Raw CLI stdout to search.
 * @param opts.tag - XML tag name to search for (default: "output").
 */
export function extractStructured(
	stdout: string,
	opts?: { tag?: string },
): ExtractResult {
	const tag = opts?.tag ?? "output";
	const block = extractTagBlock(stdout, tag);
	if (block === null) {
		return { ok: false, reason: `no <${tag}>…</${tag}> block found in stdout` };
	}

	// Pass 1: try raw block content.
	const trimmed = block.trim();
	try {
		const value = JSON.parse(trimmed);
		return { ok: true, value };
	} catch {
		// Fall through to repair pass.
	}

	// Pass 2: strip markdown fences and trailing prose.
	const repaired = repairFences(trimmed);
	try {
		const value = JSON.parse(repaired);
		return { ok: true, value };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			reason: `JSON.parse failed after repair: ${msg} (raw: ${trimmed.slice(0, 120)})`,
		};
	}
}
