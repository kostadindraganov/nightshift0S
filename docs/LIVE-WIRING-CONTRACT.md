# LIVE-WIRING CONTRACT — nightshift goes live (Linux)

Status: PINNED 2026-06-12. This is the binding contract for builders L1–L6 and
the integration step (INT). It replaces the four `"not wired"` throws in
`src/server/routes.ts` with live implementations and ships the supporting ops.

**Verified seam inventory (read 2026-06-12):**
`buildReviewDeps.{getDiff,runReviewer,resumeCoder}` and `buildPlanner.runOnce`
throw fail-closed in `src/server/routes.ts:186-216`. `buildAgentInvocation`
(`src/runs/spawn.ts:70`) has no resume support. `TmuxLauncher` is real;
`GitHubRestClient` exists but is unused; `CiClient` has no live impl;
`src/egress/` has no apply path; `web/views/TaskDetailView.tsx:372-410` has the
terminal placeholder. `runs.sessionId` is captured by hookBridge on
`SessionStart` (`src/runs/hookBridge.ts:57-66`, `src/db/schema.ts:160`).

---

## 0. Ground rules (apply to every row below)

- **NO LIVE SIDE EFFECTS during build.** No real claude/codex/gemini spawns, no
  HTTP to GitHub, no pushes, no PRs, no `nft`. Tests assert on built
  request/argv/ruleset/env objects only. The owner verifies live on Linux.
- **FAIL-CLOSED.** A missing token, binary, sandbox, or session id THROWS or
  refuses. Never silently no-op, never fabricate output.
- **HOST-SIDE TOKEN INVARIANT (§3.12.25).** The GitHub token lives ONLY inside
  `GitHubRestClient` (and the `CiClient` built on it). It must NEVER appear in:
  `buildAgentInvocation` env, `SandboxProfile.envAllowlist`, tmux `-e` args,
  one-shot spawn env, or any file under a worktree/per-task HOME.
- House rules: TypeScript + ESM + Bun. TABS in `src/`, 2-space in `web/` and
  shell. JSDoc "WHY" header per new file (model: `src/orchestrator/coder.ts`).
  One focused `*.test.ts` per new module, ≤4 hermetic cases, test only your own
  dir. Do NOT run full-project typecheck (INT does); typecheck your files with
  `bunx tsc --noEmit` only if you must, prefer `bun test src/<your-dir>`.
- Do not edit files outside your ownership row. Cross-dir **imports** are fine;
  cross-dir **edits** are not.

---

## 1. PINNED DESIGN DECISIONS

### D1 — Reviewer + planner are non-interactive captured-stdout one-shots

The verdict and the backlog are structured one-shots (BLUEPRINT §3.4
"API-direct one-shots: coordinator judging"). tmux + hooks is reserved for the
interactive **coder** only. Reviewer/planner spawn via `Bun.spawn` with stdout
captured — no tmux session, no hook bridge, no run watchdog.

New module `src/live/oneShot.ts`:

```ts
export interface OneShotSpec {
	argv: string[];          // built by buildOneShotArgv — never includes the prompt
	prompt: string;          // ALWAYS delivered via stdin (never argv → no ps leak,
	                         // never a file → no cleanup races)
	cwd: string;             // reviewer: the task worktree; planner: a scratch dir
	home: string;            // per-task HOME (reviewer: homeRoot/<taskId>;
	                         // planner: homeRoot/planner)
	providerAuthDir: string; // ro-bound provider credential dir (e.g. <home>/.claude)
	timeoutMs?: number;      // default 600_000; on expiry kill() and throw
}

export interface OneShotResult { stdout: string; exitCode: number }

/** Injectable spawner so tests never create processes. */
export type OneShotSpawner = (spec: OneShotSpec) => Promise<OneShotResult>;

export class OneShotDisabledError extends Error {}

/** Pure argv builder — THE single place provider CLI flags live. */
export function buildOneShotArgv(provider: string): string[];
// "claude-code" | "claudeCode" → ["claude", "--print"]            (prompt on stdin)
// "codex"                     → ["codex", "exec", "-"]            (prompt on stdin)
// anything else               → throw OneShotDisabledError (fail-closed)
// NOTE: codex flag spelling is a Linux-verify item; adjust HERE only.

/** Pure env builder — minimal allowlist; NEVER a GitHub token. */
export function buildOneShotEnv(home: string): Record<string, string>;
// { HOME: home, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
//   LC_ALL: "C", LANG: "en_US.UTF-8" }  — nothing else. No NIGHTSHIFT_*,
//   no GITHUB_TOKEN, no SSH_AUTH_SOCK.

/** The live spawner. */
export const spawnOneShotCaptured: OneShotSpawner;
```

`spawnOneShotCaptured` behaviour (PINNED):

1. On **Linux**: build a `SandboxProfile { worktreePath: cwd, taskHome: home,
   providerAuthDir, envAllowlist: buildOneShotEnv(home) }` and spawn via
   `spawnSandboxed(profile, argv)` (`src/sandbox/spawn.ts`) — bwrap absent ⇒
   `SandboxDisabledError` propagates (fail-closed). Write `prompt` to the
   subprocess stdin, close stdin, await exit, capture stdout.
2. On **non-Linux**: throw `OneShotDisabledError` UNLESS
   `process.env.NIGHTSHIFT_ALLOW_UNSANDBOXED_ONESHOTS === "1"`, in which case
   spawn directly with `Bun.spawn(argv, { cwd, env: buildOneShotEnv(home),
   stdin: "pipe", stdout: "pipe", stderr: "pipe" })`. This escape hatch is for
   ATTENDED local dev only and is never set by any shipped config/unit file.
3. Non-zero exit or timeout ⇒ throw (the review engine treats it as a failed
   produce → `needs_human` escalation; the planner route 422s).

Every reviewer one-shot is recorded as a run row (kind `"reviewer"`) so
findings/verdicts have a `runId`: `createRun` → `transitionRun` queued→starting
→running, spawn, then →finishing→succeeded|failed (`src/runs/transitions.ts`
already allows this path; no tmux/watchdog involved — `tmuxSession` stays
null). Planner one-shots are NOT recorded as runs (no task to bind to).

### D2 — resumeCoder resumes the interactive tmux coder via `--resume`

`src/runs/spawn.ts` gains resume support (L3):

```ts
export interface BuildAgentInvocationInput {
	/* …existing fields… */
	resumeSessionId?: string;   // NEW
}
export interface SpawnRunInput {
	/* …existing fields… */
	resumeSessionId?: string;   // NEW — passed through to buildAgentInvocation
}
```

When `resumeSessionId` is set, the prompt-via-file one-liner becomes:

```
p=$(cat '<promptFile>'); rm -f '<promptFile>'; exec <cli> --resume '<sessionId>' "$p"
```

(`<sessionId>` single-quoted with the same `'\''` escaping as TmuxLauncher;
applies to claude and codex alike — the router never selects codex as coder
because `coder` requires proven `resume`, so the generic builder is safe.)

**Session-id resolution (PINNED):** the coder's session id is captured by the
hook bridge on `SessionStart` into `runs.sessionId`. `resumeCoder` resolves it
as: latest run for the task with `kind='coder' AND sessionId IS NOT NULL`,
ordered by `id DESC`, limit 1 → `run.sessionId`. If none exists ⇒ **throw**
`new Error("no coder session to resume for task <id>")` (fail-closed; the
review route surfaces 500 and the task stays in `review`).

`resumeCoder` (L2, in `src/live/review.ts`) = `createRun(handle, { taskId,
kind: "coder", provider, model, authLane })` then `spawnRun(deps, { …,
resumeSessionId, prompt: buildFindingsPrompt(findings) })` → returns
`{ runId: run.id }`. `createWorktree` already reuses the existing worktree.
`buildFindingsPrompt(findings: FindingRow[]): string` is a pure builder
(file/severity/description/suggestion per finding + "fix and commit" frame) —
hermetically tested.

### D3 — Live ForgeClient + CiClient; token resolution order

New `src/forge/token.ts` (L5):

```ts
export class TokenUnavailableError extends Error {}

/** Order: 1) env.GITHUB_TOKEN (non-empty) → 2) `gh auth token` stdout
 *  (trimmed, non-empty) → 3) throw TokenUnavailableError. Never logged,
 *  never cached to disk, resolved once at server boot by INT. */
export function resolveGithubToken(
	env?: Record<string, string | undefined>,          // default process.env
	ghAuthToken?: () => Promise<string>,               // default: execFile("gh", ["auth","token"])
): Promise<string>;
```

New `src/forge/repoUrl.ts` (L5):

```ts
/** Parses git@github.com:owner/repo.git | https://github.com/owner/repo(.git)
 *  | ssh://git@github.com/owner/repo.git → { owner, repo }; throws otherwise. */
export function parseRepoUrl(remoteUrl: string): { owner: string; repo: string };
```

New `src/gate/checksClient.ts` (L5) — live `CiClient` over the SAME
`ForgeClient` transport so the token lives in exactly one class
(`GitHubRestClient`, already implemented, base `https://api.github.com`):

```ts
/** Pure mapper: GitHub check-run {status, conclusion} → CheckRun.status.
 *  status!=="completed" → "pending"; conclusion: success→success,
 *  neutral→neutral, skipped→skipped, failure|timed_out→failure,
 *  cancelled|action_required|stale|null→error. */
export function mapCheckRun(raw: { name: string; status: string; conclusion: string | null }): CheckRun;

export class GithubChecksClient implements CiClient {
	constructor(client: ForgeClient, owner: string, repo: string);
	// GET /repos/{owner}/{repo}/commits/{encodeURIComponent(ref)}/check-runs?per_page=100
	// non-2xx ⇒ throw (fail-closed: gate escalates, never passes).
	fetchChecks(ref: string): Promise<CheckRun[]>;
}
```

PR open path is already complete (`prepareAndOpenPR` → `openPullRequest` →
`GitHubRestClient`); INT only constructs `new GitHubRestClient(await
resolveGithubToken())` host-side. **The token never crosses into any agent
env — see ground rules.** Pushes use `defaultPusher` (git-over-SSH via the
host's ssh-agent; no token involved).

### D4 — xterm.js terminal: read-only WS attach to the run's tmux pane

New `src/term/attach.ts` (L4):

```ts
/** "/runs/123/term" → 123; anything else → null. Pure. */
export function matchTermPath(pathname: string): number | null;

/** Bearer auth for WS (browsers cannot set Authorization on WebSocket):
 *  token arrives as ?token=<bearer>; compared sha256+timingSafeEqual against
 *  NIGHTSHIFT_API_TOKEN. Unset env ⇒ {ok:false,status:503}; mismatch ⇒ 401.
 *  (Self-contained constant-time compare — does NOT edit src/server/auth.ts.) */
export function authenticateWsToken(url: URL): { ok: true } | { ok: false; status: 401 | 503 };

/** Pure argv builders — hermetically tested. */
export function buildPipePaneArgs(session: string, logFile: string): string[];
// ["tmux","pipe-pane","-o","-t",session,`cat >> '${logFile}'`]
export function buildCapturePaneArgs(session: string): string[];
// ["tmux","capture-pane","-pe","-t",session,"-S","-1000"]

export interface TermSocketData { runId: number; tmuxSession: string; logFile: string }

/** Per-connection lifecycle:
 *  open  → run capture-pane (backlog) and send; start pipe-pane to
 *          <run.homePath>/term-<runId>.log (idempotent — pipe-pane -o replaces);
 *          tail the log file (fs.watch + incremental read) → ws.send(bytes).
 *  message → DROPPED. Read-only is structural: this module contains no
 *            send-keys / stdin path at all.
 *  close → stop the tail watcher (pipe-pane may keep logging; harmless). */
export function makeTermWebsocket(handle: DbHandle): Bun.WebSocketHandler<TermSocketData>;

/** Fetch-side helper used by main.ts: validates run exists + has a live
 *  tmuxSession, auths the token, then server.upgrade(req,{data}). Returns a
 *  Response on refusal, undefined when upgraded. */
export function handleTermUpgrade(
	server: Bun.Server<TermSocketData>, req: Request, url: URL, handle: DbHandle,
): Response | undefined;
```

**Wiring (INT, PINNED — server-level, not per-route):** in
`src/server/main.ts`, `Bun.serve` gains `websocket: makeTermWebsocket(handle)`
and the fetch handler becomes `async fetch(req, server)` with, BEFORE
`matchRoute`:

```ts
const termId = matchTermPath(url.pathname);
if (termId !== null && req.method === "GET") {
	const r = handleTermUpgrade(server, req, url, handle);
	if (r !== undefined) return r;   // refusal Response
	return undefined as never;        // upgraded — Bun owns the socket now
}
```

Client (L4): `web/components/RunTerminal.tsx` — `@xterm/xterm` (+
`@xterm/addon-fit`), `disableStdin: true`, connects to
`ws(s)://<host>/runs/<id>/term?token=<bearer>`, writes incoming bytes to the
term. `TaskDetailView.tsx` replaces the placeholder block (lines 372–410) with
`<RunTerminal runId={…}/>` for the task's latest non-terminal run, keeping the
existing placeholder as the empty/disconnected state. INT adds the two npm
deps to `package.json`.

### D5 — Egress apply: nft on Linux, fail-closed elsewhere

New `src/egress/apply.ts` (L6):

```ts
export class EgressApplyError extends Error {}

export interface ApplyDeps {
	/** Injectable host→IPv4 resolver; default node:dns/promises resolve4. */
	resolve?: (host: string) => Promise<string[]>;
	/** Injectable command runner; default execFile. Tests inject a fake. */
	run?: (argv: string[]) => Promise<string>;
	platform?: NodeJS.Platform;   // default process.platform
}

/** Pure: per-host `nft add element` argv lists from resolved IPs.
 *  [["nft","add","element","inet",`nightshift_egress_uid${uid}`,
 *    `allowed_ips_${i}`,`{ ${ips.join(", ")} }`], …]  (skip hosts with 0 IPs ⇒
 *  the set stays empty ⇒ that host stays DROPPED — fail-closed, never error). */
export function buildAddElementCmds(uid: number, ipsByHostIndex: string[][]): string[][];

/** 1) platform!=="linux" ⇒ throw EgressApplyError (fail-closed — never no-op).
 *  2) buildNftablesRuleset(cfg) → write to a 0600 temp file → run ["nft","-f",file].
 *  3) resolve every cfg.allowedHosts → run each buildAddElementCmds argv.
 *  4) verify: run ["nft","list","table","inet",`nightshift_egress_uid${uid}`]. */
export function applyEgressRuleset(deps: ApplyDeps, cfg: EgressConfig): Promise<void>;
```

`src/egress/applyCli.ts` (L6): thin `bun` CLI — `bun src/egress/applyCli.ts
--uid <uid> [--host <h>]…` (hosts default to
`defaultAllowedHosts(["api.anthropic.com","api.openai.com"])`); calls
`applyEgressRuleset`. `ops/egress-apply.sh` (L6) is the root wrapper that
invokes it (nft needs root).

**When the unattended gate flips (PINNED, operational — never automatic in
code):** (1) operator runs `sudo ops/egress-apply.sh` on the Linux host (or via
the systemd unit's `ExecStartPre`); (2) `egressActive()` now finds the
`nightshift_egress_uid*` table (the table name generated by
`buildNftablesRuleset` already matches guard.ts's `NFT_TABLE_PREFIX`); (3) only
then may the operator set `sandbox.unattendedUntrustedRepos: true` in
`nightshift.config.json`. Defaults stay false. INT wires the runtime check —
`assertEgressOrRefuse({ egressActive: await egressActive(), unattended,
trustedRepo })` — into the autonomous run-start path (scheduler-triggered
`startCoderTask`), with `unattended=true` for any non-human-initiated spawn.

### D6 — Provider/model/lane pinning for live one-shots

- Reviewer provider: `loadConfig().providers.defaultReviewer` (default
  `"codex"`); planner provider: `providers.defaultCoder` (default
  `"claude-code"`). INT may add a `review.provider` override knob to
  `config.ts` if desired — config.ts edits are INT-owned.
- Run-row `model`: literal `"cli-default"` (CLI picks its own model).
  `authLane`: `"subscription"` for claude-code, `"api_key"` for codex.
- `getDiff` (L2): worktree = latest coder run's `worktreePath` (throw if none);
  `headSha = (await git(["rev-parse","HEAD"], wt)).trim()`; `diff = await
  git(["diff", `${task.baseSha}..HEAD`], wt)` (throw if `task.baseSha` empty);
  `prTitle = "[ns#"+task.id+"] "+task.title`; `prBody = task.description ?? ""`.
  Uses the injectable `GitRunner` (default `execGit`) — host-side git only.
- `runReviewer` re-resolves `headSha` AFTER the one-shot exits so
  `runReviewRound`'s SHA-binding check (review.ts step 6) is honest.

---

## 2. FILE-OWNERSHIP TABLE (zero overlap)

| Row | Builder scope | Files (C=create, E=edit) | Exports others import |
|-----|---------------|--------------------------|------------------------|
| **L1** | Live one-shot runtime + planner | C `src/live/oneShot.ts`, C `src/live/planner.ts`, C `src/live/oneShot.test.ts` | `buildOneShotArgv`, `buildOneShotEnv`, `spawnOneShotCaptured`, `OneShotSpawner`, `OneShotSpec`, `OneShotDisabledError`; `makeLivePlanner(cfg?: { spawner?: OneShotSpawner }): Planner` |
| **L2** | Review live deps | C `src/live/review.ts`, C `src/live/review.test.ts` | `makeGetDiff(cfg): ReviewDeps["getDiff"]`, `makeRunReviewer(cfg): ReviewDeps["runReviewer"]`, `makeResumeCoder(cfg): ReviewDeps["resumeCoder"]`, `buildFindingsPrompt`, `latestCoderSessionId(handle, taskId): string \| null` — each `make*` takes `{ handle, log, git?, spawner?, launcher? }` so tests inject fakes |
| **L3** | Coder resume in runs | E `src/runs/spawn.ts` (add `resumeSessionId` to both input types + one-liner), E `src/runs/spawn.test.ts` (+≤2 cases) | `BuildAgentInvocationInput.resumeSessionId`, `SpawnRunInput.resumeSessionId` |
| **L4** | Terminal (server + web) | C `src/term/attach.ts`, C `src/term/attach.test.ts`, C `web/components/RunTerminal.tsx`, E `web/views/TaskDetailView.tsx` (placeholder block only) | `matchTermPath`, `authenticateWsToken`, `buildPipePaneArgs`, `buildCapturePaneArgs`, `makeTermWebsocket`, `handleTermUpgrade`, `TermSocketData` |
| **L5** | Forge token + live CI | C `src/forge/token.ts`, C `src/forge/repoUrl.ts`, C `src/forge/token.test.ts` (covers repoUrl too), C `src/gate/checksClient.ts`, C `src/gate/checksClient.test.ts` | `resolveGithubToken`, `TokenUnavailableError`, `parseRepoUrl`, `GithubChecksClient`, `mapCheckRun` |
| **L6** | Egress apply + ops | C `src/egress/apply.ts`, C `src/egress/applyCli.ts`, C `src/egress/apply.test.ts`, C `ops/egress-apply.sh`, C `ops/nightshift.service`, C `ops/deploy.sh` | `applyEgressRuleset`, `buildAddElementCmds`, `EgressApplyError`, `ApplyDeps` |
| **INT** | Integration (owner-driven) | E `src/server/routes.ts` (wire D1/D2/D3 into `buildReviewDeps`+`buildPlanner`), E `src/server/main.ts` (D4 WS upgrade, `fetch(req, server)`), E `package.json` (`@xterm/xterm`, `@xterm/addon-fit`), E `src/config/config.ts` (live knobs: `forge.requiredChecks: string[]` default `[]`; optional `review.provider`), full-project typecheck + `bun test` | — |

Ownership notes:
- `src/live/` is split by FILE between L1 and L2 — L1 must not touch
  `review.ts`, L2 must not touch `oneShot.ts`/`planner.ts`. L2 imports L1's
  types only (`OneShotSpawner`); build against the signature above.
- Nobody edits: `src/orchestrator/*`, `src/forge/{github,push,forge}.ts`,
  `src/gate/{ci,gate,freshness}.ts`, `src/egress/{allowlist,guard}.ts`,
  `src/sandbox/*`, `src/providers/*`, `src/runs/{launcher,runs,transitions,hookBridge,watchdog,reap}.ts`,
  `src/server/{auth,reviewRoutes,plannerRoutes}.ts` — they are complete.
- `ops/nightshift.service` is modeled on `ops/reference/tank.service`
  (`KillMode=process` so tmux+claude survive deploys; `EnvironmentFile=-` for
  `NIGHTSHIFT_API_TOKEN`/`GITHUB_TOKEN`; `ExecStart=bun src/server/main.ts`;
  PATH includes `$SERVICE_HOME/.local/bin` for the native claude install).
  `ops/deploy.sh` is modeled on `ops/reference/deploy.sh` (idempotent SSH
  deploy, refuses system-wide claude, installs user-level hooks pointing at
  `ops/hook.sh`, daemon-reload + restart + health check on `/healthz`).

INT wiring sketch for `routes.ts` (kept fail-closed-on-invoke: nothing spawns
or resolves a token until a request actually invokes the closure; a missing
token/binary/bwrap throws INSIDE the call):

```ts
const buildReviewDeps: ReviewRoutesConfig["buildDeps"] = (ctx) => ({
	handle: ctx.handle, log: ctx.events, thread: threadApi,
	engine: runVerdict, judge: codeReviewJudge,
	getDiff: makeGetDiff({ handle: ctx.handle }),
	runReviewer: makeRunReviewer({ handle: ctx.handle, log: ctx.events }),
	resumeCoder: makeResumeCoder({ handle: ctx.handle, log: ctx.events, launcher: new TmuxLauncher() }),
	maxRounds: loadConfig().review.maxRounds,
});
const buildPlanner: PlannerRoutesConfig["buildPlanner"] = () => makeLivePlanner();
```

---

## 3. VERIFICATION MATRIX (macOS-verifiable vs Linux-verify-only)

| Deliverable | macOS (typecheck + hermetic unit test) | Linux-verify-only (owner) |
|---|---|---|
| L1 `buildOneShotArgv` / `buildOneShotEnv` | ✔ argv per provider; throw on unknown; env has no token/SSH_AUTH_SOCK | live claude/codex one-shot under bwrap |
| L1 `spawnOneShotCaptured` fail-closed | ✔ non-Linux without escape hatch throws `OneShotDisabledError` (no process created — assert via injected spawner never called) | sandboxed spawn, stdin prompt delivery, timeout kill |
| L1 `makeLivePlanner` | ✔ with fake spawner: prompt passthrough, stdout passthrough, spawn-failure propagates | live bootstrap producing real drafts |
| L2 `makeGetDiff` | ✔ fake `GitRunner`: argv asserted (`rev-parse HEAD`, `diff base..HEAD`), missing baseSha/worktree throws | real worktree diff |
| L2 `makeRunReviewer` / `makeResumeCoder` | ✔ fake spawner/launcher + :memory: DB: run rows created, headSha re-resolved, `--resume` reaches the launcher command, no-session throws | full review round + tmux resume |
| L2 `buildFindingsPrompt`, `latestCoderSessionId` | ✔ pure / :memory: DB | — |
| L3 `buildAgentInvocation` resume | ✔ one-liner contains `--resume '<id>'` exactly when set; absent otherwise | tmux session actually resumes claude |
| L4 `matchTermPath`, `authenticateWsToken`, argv builders | ✔ pure; 503 when env unset, 401 on mismatch | live WS attach, pipe-pane tail, xterm render |
| L4 `RunTerminal.tsx` | ✔ typecheck only (no DOM test) | visual check on deploy host |
| L5 `resolveGithubToken` | ✔ fake env/gh: order, trim, throw | `gh auth token` on host |
| L5 `parseRepoUrl`, `mapCheckRun`, `GithubChecksClient` | ✔ fake ForgeClient: exact GET path asserted, non-2xx throws, status mapping table | live check-runs against a real ref |
| L5 PR pipeline (already built) | ✔ existing tests | live push + PR open (token host-side) |
| L6 `buildAddElementCmds` | ✔ pure: argv shape, empty-IP host skipped | — |
| L6 `applyEgressRuleset` | ✔ fake `run`/`resolve`: non-Linux throws; on fake-Linux the nft argv sequence is asserted, no real exec | `nft -f` apply, default-DROP probe, `egressActive()` flips |
| L6 `ops/*.sh`, `ops/nightshift.service` | ✔ `bash -n` syntax check only | deploy, systemd enable/start, healthz |
| INT routes/main/package wiring | full-project `bunx tsc --noEmit` + `bun test` (note: run `bun test src/...` per-dir to dodge the vendor collision) | end-to-end: task → coder → gate → PR → review → resume → merge |

---

## 4. NON-GOALS (this wave)

- No merge-webhook listener (`confirmMergeAndUnblock` stays API/poll-driven).
- No gemini driver, no API-key lane plumbing beyond what exists.
- No write-path terminal (read-only attach only — by construction).
- No auto-flip of `sandbox.unattendedUntrustedRepos` (operator-only, D5).
