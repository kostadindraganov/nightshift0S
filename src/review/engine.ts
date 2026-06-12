/**
 * WHY: The ONE verdict-loop engine (PHASE3-CONTRACT §4.4). Pure-ish — no
 * spawning, no DB — so it is fully unit-testable; the producer closure owns
 * all side effects. FAIL-CLOSED by construction: the only way to get
 * `{ok:true}` is a stdout that survives the judge's extract+validate path;
 * a parse failure can only ever re-prompt (bounded) or return `{ok:false}` —
 * never a fabricated "approved".
 */

import type { Judge } from "./judge.ts";
import type { Verdict } from "./verdict.ts";

export const DEFAULT_REPAIR_RETRIES = 2;

/** attempt 0 = judge.buildPrompt(ctx); attempt 1..N = the fixed repair prompt. */
export type Producer = (prompt: string, attempt: number) => Promise<string>;

export type EngineResult = { ok: true; verdict: Verdict } | { ok: false; reason: string };

/**
 * Run one verdict loop: produce(judge.buildPrompt(ctx), 0) → judge.parse.
 * On {ok:false}, re-prompt with the fixed repair template up to
 * `repairRetries` more times. Exhausted ⇒ {ok:false, reason}.
 */
export async function runVerdict<Ctx>(
	judge: Judge<Ctx>,
	ctx: Ctx,
	produce: Producer,
	opts?: { repairRetries?: number },
): Promise<EngineResult> {
	const retries = opts?.repairRetries ?? DEFAULT_REPAIR_RETRIES;
	let prompt = judge.buildPrompt(ctx);
	let last: EngineResult = { ok: false, reason: "no attempts made" };
	for (let attempt = 0; attempt <= retries; attempt++) {
		const stdout = await produce(prompt, attempt);
		const parsed = judge.parse(stdout);
		if (parsed.ok) return { ok: true, verdict: parsed.verdict };
		last = { ok: false, reason: parsed.reason };
		prompt = `Your previous output could not be parsed (${parsed.reason}). Re-emit ONLY the JSON verdict wrapped in <${judge.tag}></${judge.tag}> tags. No prose.`;
	}
	return last;
}
