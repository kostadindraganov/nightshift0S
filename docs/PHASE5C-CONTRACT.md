# Phase 5 Batch C Contract — auto-merge preflight + provider matrix (toward GATE 5)

Status: BINDING for builders C1–C4. Verified against the real code on 2026-06-13.
Plan items: 5.1 auto-merge preflight + PR merge, 5.4 provider matrix (new drivers behind the conformance harness).
Specs: BLUEPRINT §3.12.26 (auto-merge preflight — EVERY merge, not just setup), §3.12.1 (auto-merge is V1.5, gated), §3.9 (provider matrix), §3.12.13/.30 (capabilities are PROVEN, not declared), §3.12.18 (failback ≠ routing: new drivers join routing only at task start, never mid-task); SPEC-STATE-MACHINES §1 (Task) — verdicts bind to head SHA; a new push invalidates approval (§4).

House rules (all builders): TypeScript + ESM + Bun. TABS in `src/`. Every new file opens with a JSDoc `WHY` header (see `src/orchestrator/coder.ts`). ALL side-effects injectable — every module in this batch runs on macOS with fakes: NO live GitHub merge, NO live agent/CLI spawn, NO network in tests. FAIL-CLOSED everywhere: a missing field, uncertain signal, or API error BLOCKS the merge; an unproven capability is NEVER used (the router only sees `proven`). FEWER TESTS: one focused `*.test.ts` per module (C3/C4 may consolidate per the table), ≤5 hermetic cases each. Test ONLY your own files (commands pinned below). Do NOT run the full suite or project typecheck. Do NOT edit INTEGRATION-owned files: `src/providers/router.ts`, `src/config/config.ts`, `src/server/routes.ts`, `src/server/main.ts`, `package.json`, and the (new) driver registry — read them, propose knobs/registrations in your return, do not edit.

No DB migration. Everything needed exists: `providers.capabilities_json` (written ONLY by `recordCapabilities`), task edges `approved→merging` (merge_start), `merging→done` (merge_confirmed — the ONLY writer of `merge_sha`), `merging→needs_human` (merge_blocked). NOTE: there is NO `approved→needs_human` edge — a preflight block leaves the task in `approved` (see §4.2 stage map).

---

## 1. File-ownership table (no two builders touch the same file)

| Builder | Creates | Edits | Test command |
|---|---|---|---|
| **C1 preflight+merge** | `src/forge/preflight.ts`, `src/forge/preflight.test.ts`, `src/forge/mergeClient.ts`, `src/forge/mergeClient.test.ts` | — | `bun test src/forge/preflight.test.ts src/forge/mergeClient.test.ts` |
| **C2 auto-merge orchestrator** | `src/orchestrator/autoMerge.ts`, `src/orchestrator/autoMerge.test.ts` | — | `bun test src/orchestrator/autoMerge.test.ts` |
| **C3 CLI drivers** | `src/providers/gemini.ts`, `src/providers/opencode.ts`, `src/providers/antigravity.ts`, `src/providers/cliDrivers.test.ts` (ONE combined test file, ≤5 cases total) | — | `bun test src/providers/cliDrivers.test.ts` |
| **C4 API drivers** | `src/providers/openrouter.ts`, `src/providers/local.ts`, `src/providers/apiDrivers.test.ts` (ONE combined test file, ≤5 cases total) | — | `bun test src/providers/apiDrivers.test.ts` |
| **INTEGRATION** (not a builder) | `src/providers/registry.ts` (driver registry, §6) | `src/config/config.ts` (knobs §7), `src/server/main.ts` (boot conformance + auto-merge hook §8), `src/server/routes.ts` (optional), `package.json` | — |

Parallel-build rule (PHASE5A pattern): C2 does NOT import C1 at runtime — it declares local structural ports (§4.1) duck-compatible with C1's pinned exports; INTEGRATION binds the real functions. C3 and C4 are leaf driver files importable independently; only INTEGRATION's registry assembles them. C2 MAY import `confirmMergeAndUnblock` from `src/orchestrator/coder.ts` (own dir, stable seam).

Shared invariants: all DB writes via `enqueueWrite`; events inside a writer link via `log.emitInWriter`, outside via `log.emitEvent`; task state ONLY via `transitionTask(handle, log, {taskId, to, expectedFrom, actor, extra})`; `{ok:false, reason:"lost_race"}` is a tolerated no-op, never thrown, never blindly retried. Do NOT add task/run edges; do NOT edit `src/tasks/transitions.ts`.

---

## 2. Reuse map — what already exists (lean on it, do NOT reinvent)

| Need | Existing seam | Exact signature |
|---|---|---|
| Injectable GitHub REST | `src/forge/github.ts` | `interface ForgeClient { request(req: {method: string; path: string; body?: unknown}): Promise<{status: number; json: unknown}> }` — C1 takes this, NEVER fetch directly |
| Live client factory (host-only) | `src/forge/githubForgeClient.ts` | `createGitHubForgeClient(baseUrl?, spawner?): Promise<ForgeClient>` — token from `GITHUB_TOKEN` → `gh auth token`, fail-closed throw. INTEGRATION wires it; builders never call it |
| PR open precedent (shape to copy) | `src/forge/github.ts` | `openPullRequest(client, args): Promise<{number, url}>` — request-builder + status check + shape validation; `mergePullRequest` follows this pattern |
| merging→done + dependent unblock | `src/orchestrator/coder.ts` | `confirmMergeAndUnblock(deps: {handle, log}, taskId, mergeSha): Promise<{ok, reason?, unblocked: number[]}>` — requires task in `merging`; the ONLY path to `done` |
| Task transitions | `src/tasks/transitions.ts` | `approved→merging` (merge_start), `merging→done` (merge_confirmed, `extra.mergeSha` REQUIRED), `merging→needs_human` (merge_blocked) |
| Approved-SHA source | `src/orchestrator/review.ts` | verdict thread event: `kind:"verdict"`, payload `{verdict:"approved", summary, headSha, findingIds}`, idempotencyKey `verdict:{taskId}:{round}:{headSha}` — SHA binding enforced at review time (step 6) |
| PR-number source | `src/orchestrator/coder.ts` step 12 | event `task.pr_opened` payload `{taskId, pr: {number, url}}` (no DB column for PR number — read the event log) |
| Driver contract | `src/providers/types.ts` | `ProviderDriver { name, kind: "cli"\|"api", declared: Capabilities, runOnce({prompt, cwd?}): Promise<{stdout, sessionId?, tokensIn?, tokensOut?, costUsd?}>, resumeOnce({sessionId, prompt}): Promise<{stdout}>, isAvailable(): Promise<boolean> }` |
| Capability axes (REAL names) | `src/providers/types.ts` | `Capabilities { interactive, resume, fork, structured_output, cost_reporting: boolean; auth: AuthLane[]; roles: RunKind[] }` (`AuthLane = subscription\|api_key\|local`) |
| Conformance harness | `src/providers/conformance.ts` | `runConformance(driver, probes = PROBES): Promise<ProvenReport>`; `PROBES: ConformanceProbe[]` (resume, structured_output, cost_reporting); `recordCapabilities(handle, providerName, report)`; unavailable driver → all probes skipped, proven all-false |
| Structured-output envelope | `src/providers/schemaRepair.ts` | `extractStructured(stdout, {tag: "output"})` — XML-tag extraction; UNTRUSTED until the probe proves it |
| Router (INTEGRATION consults) | `src/providers/router.ts` | `selectDriver(drivers: {driver, proven}[], role): ProviderDriver \| null`; `requiredCapabilities(role)` — reviewer/judge need `structured_output`, coder needs `resume` |
| CLI driver precedents | `src/providers/claudeCode.ts`, `codex.ts` | const driver objects; `resolveBin` via `which` PATH probe; `execFileAsync` with 5-min timeout + `LC_ALL: "C"`; `resumeOnce` throws defensively when `declared.resume === false` |
| Existing knobs | `src/config/config.ts` | `review.autoMergeEnabled` (default **false** — NOT `forge.*`), `sandbox.unattendedUntrustedRepos` (default false), `forge.provider` ("github") |
| Repo coordinates | `src/orchestrator/coder.ts` | `RepoConfig { repoDir, worktreePath, remoteUrl, owner, repo, defaultBranch, requiredChecks? }` via injected `resolveRepo` |

baseBranch pin: preflight needs the protected branch **NAME** = `RepoConfig.defaultBranch`. (The PR-open path currently passes `baseSha` as the PR `base` — pre-existing quirk, do NOT propagate it into preflight.)

---

## 3. OWNER C1 — `src/forge/preflight.ts` + `src/forge/mergeClient.ts` (§3.12.26)

Runs before EVERY merge, never just at setup. All GitHub access through the injected `ForgeClient` — no live calls, no fetch, no token handling in this module. NEVER throws: every exception, non-2xx (outside the defined 404 semantics), or missing/odd-shaped field becomes a `blocked[]` reason. All five checks are evaluated (collect ALL reasons — operator visibility), `ok = blocked.length === 0`.

### 3.1 Pinned exports — `preflight.ts`

```ts
import type { ForgeClient } from "./github.ts";

export interface PreflightInput {
	owner: string;
	repo: string;
	prNumber: number;
	/** Protected branch NAME (RepoConfig.defaultBranch) — not a SHA. */
	baseBranch: string;
	/** Locally-recorded PR head (from task.pr_opened / run row). */
	headSha: string;
	/** The SHA the approving verdict bound to (verdict thread event payload.headSha). */
	approvedSha: string;
	/** config forge.trustedCheckAppIds — EMPTY ⇒ check (b) blocks (fail-closed). */
	trustedCheckAppIds: number[];
}

export interface PreflightResult { ok: boolean; blocked: string[]; }

export function autoMergePreflight(client: ForgeClient, input: PreflightInput): Promise<PreflightResult>;
```

### 3.2 Pinned checks (five REST reads, all via `client.request`)

1. **PR snapshot** — `GET /repos/{owner}/{repo}/pulls/{prNumber}`. Non-200 → block. Require `state === "open"`, `base.ref === baseBranch`, and capture `liveHead = head.sha` (missing → block).
2. **(a) Protection/ruleset EXISTS on baseBranch** —
   `GET /repos/{owner}/{repo}/branches/{baseBranch}/protection`: 200 ⇒ classic protection exists (capture `required_status_checks.contexts`); 404 ⇒ none (not an error, continue); other status → block.
   `GET /repos/{owner}/{repo}/rules/branches/{baseBranch}`: 200 with array ⇒ active rules (capture contexts of any `type === "required_status_checks"` rule); 404/empty ⇒ none; other status → block.
   Neither classic protection NOR a non-empty ruleset → block `"no branch protection or ruleset on <baseBranch>"`.
3. **(b) Required checks from TRUSTED apps** — `requiredNames` = union of contexts from step 2. Empty `requiredNames` → block `"no required status checks configured"` (protection without checks is not a CI gate). Empty `trustedCheckAppIds` → block `"trusted check-run app allowlist is empty"`. Then `GET /repos/{owner}/{repo}/commits/{liveHead}/check-runs` (non-200 → block); for EVERY required name there must be a check run with that `name`, `conclusion === "success"`, and `app.id ∈ trustedCheckAppIds` — missing run, non-success, missing `app.id`, or untrusted app → block per name.
4. **(c) Head FRESH** — block unless `liveHead === input.approvedSha` AND `liveHead === input.headSha`. A newer push invalidates the approval (SPEC §4) — `"head moved since approval: live=<x> approved=<y>"`.
5. **(d) Bot token has NO bypass perms** — `GET /repos/{owner}/{repo}`; require a `permissions` object (missing → block — uncertainty blocks); `permissions.admin === true` or `permissions.maintain === true` → block `"bot token has bypass-capable permissions"` (admin/maintain can bypass protection — the bot must be a plain `push` collaborator).

### 3.3 Pinned exports — `mergeClient.ts`

```ts
import type { ForgeClient } from "./github.ts";

export interface MergeInput {
	owner: string;
	repo: string;
	prNumber: number;
	/** Expected head — GitHub re-validates server-side and 409s on mismatch (defense in depth). */
	sha: string;
	method?: "squash";   // default and only V1.5 value
}

export type MergeResult =
	| { merged: true; mergeSha: string }
	| { merged: false; reason: string };

export function mergePullRequest(client: ForgeClient, input: MergeInput): Promise<MergeResult>;
```

`PUT /repos/{owner}/{repo}/pulls/{prNumber}/merge` body `{ sha, merge_method: "squash" }`. `merged: true` ONLY when status 200 AND `json.merged === true` AND `typeof json.sha === "string"` (that `sha` is the merge commit). Anything else — 405 (not mergeable), 409 (head mismatch), 404, malformed JSON, thrown client error — `{merged: false, reason}`. Never throws.

Tests — `preflight.test.ts` (≤5, fake ForgeClient scripted by path): all-green passes; stale head (live ≠ approvedSha) blocks; no protection AND no ruleset blocks; untrusted/missing check-run app id blocks AND empty allowlist blocks (one case, two asserts); admin-perm token blocks AND a thrown client error blocks fail-closed (one case, two asserts). `mergeClient.test.ts` (≤3): 200 merged → mergeSha; 409 → merged:false; malformed body → merged:false.

---

## 4. OWNER C2 — `src/orchestrator/autoMerge.ts` (auto-merge orchestrator)

ONLY acts when the knob is on (`review.autoMergeEnabled`, default false — V1 stays human-merge per §3.12.1). Preflight runs on EVERY attempt. All seams injected; C1 is consumed through local structural ports.

### 4.1 Pinned exports

```ts
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { TaskRow } from "../db/schema.ts";

/** Everything the merge needs, resolved per task. INTEGRATION builds the closure
 *  from the event log (task.pr_opened → prNumber; latest approved verdict thread
 *  event → approvedSha) + RepoConfig (owner/repo/defaultBranch) + run head_sha.
 *  Return null when ANY piece is missing → fail-closed block, no state change. */
export interface MergeContext {
	owner: string;
	repo: string;
	prNumber: number;
	baseBranch: string;
	headSha: string;
	approvedSha: string;
}

export interface AutoMergeDeps {
	handle: DbHandle;
	log: EventLog;
	autoMergeEnabled: boolean;                    // config review.autoMergeEnabled
	resolveMergeContext(task: TaskRow): Promise<MergeContext | null>;
	/** Structural ports — duck-compatible with C1 §3.1/§3.3 (do NOT import preflight.ts/mergeClient.ts).
	 *  INTEGRATION binds autoMergePreflight/mergePullRequest with a live ForgeClient + trustedCheckAppIds. */
	preflight(ctx: MergeContext): Promise<{ ok: boolean; blocked: string[] }>;
	merge(ctx: MergeContext): Promise<{ merged: true; mergeSha: string } | { merged: false; reason: string }>;
}

export type AutoMergeOutcome =
	| { applied: "merged"; mergeSha: string; unblocked: number[] }
	| { applied: "disabled" }                                       // knob off — no reads, no events
	| { applied: "noop"; reason: string }                           // task missing / not approved / lost race
	| { applied: "blocked_preflight"; blocked: string[] }           // task STAYS approved
	| { applied: "blocked_merge"; blocked: string[] };              // task parked merging→needs_human

export function tryAutoMerge(deps: AutoMergeDeps, taskId: number): Promise<AutoMergeOutcome>;
```

### 4.2 Pinned algorithm (stage map — which edge fires where)

1. `!deps.autoMergeEnabled` → `{applied: "disabled"}`. First check, zero side effects.
2. Task must exist and `state === "approved"` → else `{applied: "noop"}` (fail-closed: never force state).
3. `ctx = await resolveMergeContext(task)`; `null` → blocked `["merge context unresolved"]`, go to step 4-block.
4. **Preflight (while still `approved` — no edge has fired)**: `!ok` → emit event **`task.automerge_blocked`** payload `{taskId, prNumber: ctx?.prNumber ?? null, stage: "preflight", blocked}` via `log.emitEvent`, return `{applied: "blocked_preflight", blocked}`. The task STAYS `approved` (there is no approved→needs_human edge; the operator sees the event and can human-force-merge or push a fix). tryAutoMerge is re-runnable — preflight is idempotent reads.
5. **merge_start**: `transitionTask(handle, log, {taskId, to: "merging", expectedFrom: "approved", actor: "auto_merge"})`; `!ok` → `{applied: "noop", reason: "lost_race"}`.
6. **Merge**: `await deps.merge({...ctx, sha: ctx.headSha shape per port})` wrapped in try/catch (a throw == `{merged:false}`). On `merged: false` → `transitionTask merging→needs_human` (trigger merge_blocked, actor `"auto_merge"`; lost race tolerated) + emit `task.automerge_blocked` `{stage: "merge", blocked: [reason]}` → `{applied: "blocked_merge", blocked: [reason]}`.
7. **Confirm**: `confirmMergeAndUnblock({handle, log}, taskId, mergeSha)` (imported from `./coder.ts`) — does merging→done + `recomputeReadiness`. `!ok` → treat as step-6 failure (merging→needs_human + event). Else `{applied: "merged", mergeSha, unblocked}`.

Tests (≤5, all fakes — fake preflight/merge/resolveMergeContext, real in-memory DB + transitions like `coder.test.ts`): knob off → `disabled`, zero port calls; preflight block → task still `approved`, `task.automerge_blocked` emitted, merge never called; happy path → approved→merging→done, mergeSha recorded, unblocked ids returned; merge `{merged:false}` after merge_start → task in `needs_human`; task not in approved → `noop`.

---

## 5. OWNER C3 — CLI drivers `src/providers/{gemini,opencode,antigravity}.ts`

Each file: one `ProviderDriver` const following the `codex.ts` shape exactly — module-level `execFileAsync`, `resolveBin` via `which` PATH probe, 5-min timeout, `LC_ALL: "C"`, structured output left to the XML envelope (`extractStructured` runs in the harness, not the driver), `resumeOnce` throws defensively. Binaries absent on macOS ⇒ `isAvailable() === false` ⇒ `runConformance` yields proven all-false (the unproven gate) — exactly the desired fail-closed behavior. Live probes happen only on the Linux VM where the CLI is installed.

### 5.1 Pinned consts (declared = HYPOTHESIS; the probe suite gates actual use)

| Export | `name` | bin probe order | `runOnce` invocation (verify flags against the live CLI on Linux before flipping any cap) |
|---|---|---|---|
| `export const gemini` | `"gemini-cli"` | `["gemini"]` | `gemini -p <prompt>` |
| `export const opencode` | `"opencode"` | `["opencode"]` | `opencode run <prompt>` |
| `export const antigravity` | `"antigravity"` | `["antigravity"]` | `antigravity -p <prompt>` |

Declared capabilities (V1.5-honest — conservative; flip a flag ONLY together with a probe that can prove it):

| Driver | interactive | resume | fork | structured_output | cost_reporting | auth | roles |
|---|---|---|---|---|---|---|---|
| gemini-cli | true | **false** | false | true | false | `["subscription","api_key"]` | `["reviewer","planner","utility","experiment"]` |
| opencode | true | **false** | false | true | false | `["api_key"]` | `["reviewer","utility","experiment"]` |
| antigravity | false | **false** | false | true | false | `["subscription"]` | `["utility","experiment"]` |

`resume: false` everywhere ⇒ none of these can serve `coder` (router requires proven `resume`) and `resumeOnce` throws like `codex.resumeOnce` — that is intentional V1.5 scope. `kind: "cli"` for all three. Each file additionally exports its probe list for the registry seam: `export const geminiProbes = PROBES;` (etc.) — re-export the default suite from `conformance.ts` so driver-specific probes have a future home without changing the registry shape.

Tests — `cliDrivers.test.ts` (ONE file, ≤5, HERMETIC — must pass even on a machine that HAS these binaries installed, so tests NEVER call the real consts' `runOnce`/`isAvailable`): declared-shape invariants for all three (resume/fork/cost false, kind "cli", roles exclude "coder"); `resumeOnce` rejects for all three; `runConformance` against an in-file fake driver with `isAvailable: false` → all probes skipped, proven all-false; envelope round-trip via an in-file fake driver whose runOnce returns `<output>{"ok":true}</output>` → structured_output proven; probe-list exports are non-empty.

---

## 6. OWNER C4 — API drivers `src/providers/{openrouter,local}.ts` + registry seam

API drivers run NO process and NO worktree — a single HTTP round-trip on the host control plane. Keys come from host env at call time (`OPENROUTER_API_KEY`) and are NEVER placed in any agent environment (these drivers never touch `src/runs/spawn.ts` env construction). Factory pattern for injectability; the const is the registry-facing default.

### 6.1 Pinned exports (both files share this shape)

```ts
export interface ApiDriverDeps {
	fetchImpl?: typeof fetch;                       // tests inject; default globalThis.fetch
	env?: Record<string, string | undefined>;       // tests inject; default process.env
	baseUrl?: string;
	model?: string;
}

// openrouter.ts
export function makeOpenRouter(deps?: ApiDriverDeps): ProviderDriver;
export const openrouter: ProviderDriver;            // = makeOpenRouter()
export const openrouterProbes: ConformanceProbe[];  // = PROBES

// local.ts
export function makeLocal(deps?: ApiDriverDeps): ProviderDriver;
export const local: ProviderDriver;                 // = makeLocal()
export const localProbes: ConformanceProbe[];       // = PROBES
```

### 6.2 Pinned semantics

**openrouter** (`name: "openrouter"`, `kind: "api"`): baseUrl default `https://openrouter.ai/api/v1`; model from `deps.model ?? env.OPENROUTER_MODEL` (no silent default model — missing model at runOnce → throw, probe records failed). `isAvailable()` = `OPENROUTER_API_KEY` non-empty in env — NO network (hermetic everywhere; the real reachability proof is the probe run itself). `runOnce`: `POST {base}/chat/completions` body `{model, messages: [{role: "user", content: prompt}], usage: {include: true}}`, header `Authorization: Bearer <key>`; non-2xx or missing `choices[0].message.content` → throw (fail-closed; the harness records "failed"). Returns `stdout = content`, `tokensIn/tokensOut` from `usage.prompt_tokens/completion_tokens`, `costUsd` from `usage.cost`. `resumeOnce` throws (stateless HTTP). Declared: `{interactive: false, resume: false, fork: false, structured_output: true, cost_reporting: true /* probe-gated via usage accounting */, auth: ["api_key"], roles: ["reviewer","judge","planner","utility","experiment"]}`.

**local** (`name: "local"`, `kind: "api"`): Ollama / llama.cpp / LM Studio via OpenAI-compatible endpoint; baseUrl default `http://127.0.0.1:11434/v1`; model from `deps.model ?? env.NIGHTSHIFT_LOCAL_MODEL` (missing → throw at runOnce). `isAvailable()` = `GET {base}/models` via injected fetch, ~1 s abort, any throw/non-2xx → false. Same chat-completions runOnce WITHOUT auth header and WITHOUT usage mapping. Declared: `{interactive: false, resume: false, fork: false, structured_output: true, cost_reporting: false, auth: ["local"], roles: ["utility","experiment"]}` — the free lane for utility subtasks (§3.9).

Tests — `apiDrivers.test.ts` (ONE file, ≤5, injected fetch + injected env only): openrouter happy path maps content/usage/cost from a canned response; missing `OPENROUTER_API_KEY` → `isAvailable() === false`; non-2xx → `runOnce` rejects (and `resumeOnce` rejects — same case); local `isAvailable` true/false via fake fetch (200 vs throw); missing model → `runOnce` rejects.

### 6.3 The driver registry seam (INTEGRATION-owned — builders export, integration assembles)

Builders ship ONLY driver consts + probe lists. INTEGRATION creates `src/providers/registry.ts`:

```ts
/** Ordered registry — list order IS router priority (selectDriver is first-match). */
export const DRIVER_REGISTRY: { driver: ProviderDriver; probes: ConformanceProbe[]; enabledKnob: string }[] = [
	{ driver: claudeCode, probes: PROBES, enabledKnob: "providers.claudeCodeEnabled" },
	{ driver: codex,      probes: PROBES, enabledKnob: "providers.codexEnabled" },
	{ driver: gemini,     probes: geminiProbes,     enabledKnob: "providers.geminiEnabled" },
	{ driver: opencode,   probes: opencodeProbes,   enabledKnob: "providers.opencodeEnabled" },
	{ driver: antigravity, probes: antigravityProbes, enabledKnob: "providers.antigravityEnabled" },
	{ driver: openrouter, probes: openrouterProbes, enabledKnob: "providers.openrouterEnabled" },
	{ driver: local,      probes: localProbes,      enabledKnob: "providers.localEnabled" },
];
```

Boot flow (INTEGRATION, `main.ts`): for each registry entry with its knob on → `ensureProvider(...)` row (note: `providers.auth_mode` enum is `subscription|api_key` only — seed `local` with `"api_key"`) → `report = await runConformance(driver, probes)` → `recordCapabilities(handle, driver.name, report)` → keep `{driver, proven: report.proven}` in the in-memory list handed to `selectDriver`. Disabled or unavailable drivers contribute all-false proven sets and are naturally never selected. §3.12.18 reminder: adding drivers changes ROUTING (task-start selection via `resolveSpawn`) only — failback within a task stays same-provider; no mid-task driver swap.

---

## 7. Config knobs — INTEGRATION adds to `src/config/config.ts` (builders read by injection only)

| Knob | Default | Consumer |
|---|---|---|
| `forge.trustedCheckAppIds` | `[]` (empty ⇒ preflight check (b) BLOCKS — operator must explicitly trust, e.g. `15368` for GitHub Actions) | C1 via C2's bound port |
| `providers.geminiEnabled` | `false` | registry |
| `providers.opencodeEnabled` | `false` | registry |
| `providers.antigravityEnabled` | `false` | registry |
| `providers.openrouterEnabled` | `false` | registry |
| `providers.localEnabled` | `false` | registry |
| `providers.openrouterModel` | `""` (unset ⇒ runOnce refuses) | C4 via deps/env |
| `providers.localBaseUrl` | `"http://127.0.0.1:11434/v1"` | C4 |
| `providers.localModel` | `""` (unset ⇒ runOnce refuses) | C4 |

Existing knobs reused as-is: **`review.autoMergeEnabled`** (default false — the auto-merge master switch; it lives under `review`, NOT `forge`), `sandbox.unattendedUntrustedRepos`, `forge.provider`. All new-driver knobs default OFF — enabling a provider is an explicit operator act.

---

## 8. INTEGRATION wiring (after C1–C4 land; owns registry.ts/config.ts/main.ts/routes.ts/package.json)

1. Knobs §7 into `config.ts`; `registry.ts` per §6.3; boot conformance pass in `main.ts`.
2. **Auto-merge hook**: subscribe to the EventLog for `task.state_changed` with `payload.to === "approved"` → `tryAutoMerge(autoMergeDeps, taskId)` (same wake pattern as the Phase 5A scheduler). Production `autoMergeDeps`: `autoMergeEnabled` from config; `preflight` = `(ctx) => autoMergePreflight(liveForgeClient, {...ctx, trustedCheckAppIds: cfg.forge.trustedCheckAppIds})`; `merge` = `(ctx) => mergePullRequest(liveForgeClient, {owner: ctx.owner, repo: ctx.repo, prNumber: ctx.prNumber, sha: ctx.headSha, method: "squash"})`; `liveForgeClient` from `createGitHubForgeClient()` (host-side token, never agent env).
3. `resolveMergeContext` closure: prNumber ← latest `task.pr_opened` event for the task; approvedSha ← latest verdict thread event with `payload.verdict === "approved"` (`payload.headSha`); headSha ← same value (and cross-check against the latest coder run's `runs.head_sha` when present); owner/repo/baseBranch ← `RepoConfig` (`defaultBranch` is the branch NAME). Any piece missing → `null` (C2 blocks).
4. Optional read-only route: `GET /providers` already-shaped data from `providers.capabilities_json`; not required for GATE 5.
5. `package.json`: no new test glob needed if `src/forge`/`src/orchestrator`/`src/providers` are already covered — verify.

---

## 9. macOS-testable vs Linux/live matrix

| Deliverable | macOS (fakes — CI surface) | Linux/live only |
|---|---|---|
| C1 preflight + merge | ALL logic: scripted fake ForgeClient per REST path | real GitHub repo with protection + a real squash merge |
| C2 tryAutoMerge | ALL logic: fake ports + in-memory DB transitions | end-to-end approved→done against live GitHub |
| C3 CLI drivers | declared shapes, resumeOnce throws, conformance via in-file fakes | `runConformance` against the real gemini/opencode/antigravity binaries |
| C4 API drivers | ALL logic: injected fetch + injected env | live probe against openrouter.ai / a running Ollama |
| INTEGRATION registry/boot | construction with all knobs off (empty proven sets) | boot conformance pass with live CLIs/keys; auto-merge hook on the VM |

## 10. Cross-seam summary (the interfaces builders code against in parallel)

| Seam | Producer → Consumer | Pinned shape |
|---|---|---|
| preflight port | C1 → C2 (duck-typed, no import) | `(ctx: MergeContext) → Promise<{ok, blocked[]}>` over `autoMergePreflight(client, input)` (§3.1/§4.1) |
| merge port | C1 → C2 (duck-typed) | `(ctx) → Promise<{merged:true, mergeSha} \| {merged:false, reason}>` over `mergePullRequest` (§3.3) |
| merge confirm | coder.ts → C2 (direct import, own dir) | `confirmMergeAndUnblock({handle, log}, taskId, mergeSha)` (§2) |
| driver registration | C3/C4 → INTEGRATION registry | driver const + `<name>Probes: ConformanceProbe[]` per file (§6.3) |
| capability gate | conformance → router | `runConformance(driver, probes).proven` → `selectDriver([{driver, proven}], role)` — declared is never consulted post-conformance |
