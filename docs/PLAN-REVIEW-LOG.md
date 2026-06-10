# Plan Review Log: Nightshift blueprint (DARK-FACTORY-BLUEPRINT.md)
Started 2026-06-10. MAX_ROUNDS=5. Reviewer: Codex (read-only). Builder: Claude.

## Round 1 — Codex

**Findings**

- Critical: V1 runs privileged CLI agents in a non-root service user with only worktree isolation, while container/bwrap isolation is deferred to V3 ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:730)); an agent can read/write service-user home, CLI auth, SSH/git config, tmux sockets, and other repos. Fix: make per-run container/bwrap isolation with a minimal ephemeral `$HOME`, explicit mounts, and network policy part of V1 before auto-merge.

- Critical: “agents never hold forge credentials” conflicts with V1 “gh CLI” PR flow and tmux CLI agents ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:165), [DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:699)); if `gh` is authenticated in the same environment, agents can use it. Fix: host-side GitHub App/REST service owns push/PR/merge and the agent runtime has no `gh` token or authenticated remote.

- Critical: auto-merge is introduced before budgets, circuit breakers, specialist review, auth health, and sandboxing ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:701)); one malformed structured verdict can merge bad code. Fix: ship V1 with PR creation plus human merge, then enable auto-merge only after merge protection, CI status verification, and reviewer verdict audit are working.

- High: the provider matrix treats resume, structured output, cost reporting, and auth as uniform flags, but sandcastle’s provider interface has optional `sessionStorage`, provider-specific session paths, and usage parsing “only implemented by Claude Code” ([sandcastle/src/AgentProvider.ts](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/sandcastle/src/AgentProvider.ts:262)). Fix: define adapter conformance tests per provider and route only to capabilities proven by tests.

- High: “structured outputs everywhere” assumes CLI-native schemas, but sandcastle extracts XML-tagged stdout and requires prompt cooperation ([sandcastle/src/Output.ts](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/sandcastle/src/Output.ts:43), [sandcastle/README.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/sandcastle/README.md:243)). Fix: wrap CLI reviewers with retryable schema-repair logic and mark raw CLI output untrusted until validated.

- High: subscription quota scheduling is speculative; CLI subscriptions usually expose weak or no machine-readable remaining quota, so “tracks usage windows” is not implementable as stated ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:612)). Fix: model subscription lanes as opaque capacity pools driven by observed rate-limit/auth errors, operator-configured cooldowns, and conservative concurrency caps.

- High: shared service-user subscription auth is global mutable state; concurrent Claude/Codex/Gemini runs can mutate `~/.claude`, `~/.codex`, trust files, or session indexes. Fix: create per-run isolated homes or provider-level locks, and copy only the minimum auth material needed.

- High: the DB thread schema is underspecified: no message IDs, monotonic sequence, parent/reply relation, tool-call records, idempotency keys, or attachment/artifact model ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:261)). Fix: design the thread table as an append-only event stream with `task_id`, `seq`, `kind`, `actor_id`, `round`, `idempotency_key`, and artifact references.

- High: the run/task state machines are hand-waved; “task Done”, “needs human”, “back to coder”, “background_waiting”, “review”, and PR states are not reconciled into one legal transition graph. Fix: write the full task/run/review/PR state machine before coding and enforce transitions with guarded SQL updates.

- High: SQLite WAL is named, but no write serialization, busy timeout, checkpoint strategy, or transaction boundaries are specified for Bun under parallel agents. Fix: implement one DB writer queue or short explicit transactions with `busy_timeout`, WAL checkpointing, and retry policy for `SQLITE_BUSY`.

- High: dependency scheduling can double-dispatch ready tasks unless claims are atomic; the plan says “picks ready tasks” but does not specify `UPDATE ... WHERE state='queued'` style guards for tasks. Fix: add transactional task claiming with a unique active-run constraint per task and per-branch/worktree lock.

- High: branch freshness is missing from the V1 PR path; CI may pass on stale base, and dependent tasks can build on code not yet merged. Fix: require rebase/merge-base validation immediately before push/review/merge and rerun gates after updating from target branch.

- High: “delta re-review” is underspecified; line numbers drift, force-pushes rewrite diffs, and prior findings need stable anchors. Fix: store findings with commit SHA, old/new file path, patch hunk context, and resolution state tied to a review round.

- High: prompt-injection handling only strips XML boundary tags from PR metadata ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:334)); malicious repo files, issue text, comments, diffs, logs, and AGENTS.md can still steer reviewers. Fix: treat all repo/user content as quoted data, isolate system instructions, and add injection tests using hostile files/comments.

- High: settings “API keys encrypted at rest” lacks key management; if the encryption key is on the same VM and readable by the service user, compromise is equivalent to plaintext ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:597)). Fix: use OS keyring/KMS or sealed secrets with process-level access controls, plus audit logs that never include secret old/new values.

- Medium: “everything configurable from UI” in the skeleton front-loads a huge typed registry, inheritance, audit, secret storage, and hot reload before the first agent path ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:693)). Fix: start with config files/env plus a read-only settings UI, then add editable scoped settings after the core loop is stable.

- Medium: build order puts planner after coder/reviewer, but the data model needs dependency states, task acceptance criteria, and plan/thread relationships up front ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:706)). Fix: define task/dependency schema in the skeleton even if planner automation ships later.

- Medium: experiment routines claim immutable eval via “worktree path permissions” while V1 agents can execute shell commands in the worktree and likely alter scripts, env, or dependencies ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:684)). Fix: run eval outside the agent workspace in a locked harness container with read-only target checkout and explicit writable outputs.

- Medium: transcript browser promises “thinking” and full tool calls ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:225)); many CLIs do not expose hidden reasoning and tool schemas differ. Fix: define transcript as observable events only and normalize provider event envelopes without promising unavailable reasoning.

- Medium: token/cost caps depend on best-effort nullable cost data; warren’s schema shows costs are nullable and provider-specific ([warren/src/db/schema/sqlite.ts](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/warren/src/db/schema/sqlite.ts:174)). Fix: enforce hard wall-clock/process budgets universally and treat token/$ budgets as advisory unless the provider has reliable telemetry.

- Medium: “break glass comment forces merge” is dangerous without authz, replay protection, and audit semantics ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:170)). Fix: require an allowlisted maintainer identity, exact signed command syntax, fresh PR head SHA, and immutable audit event.

- Medium: webhook/chat triggers can create tasks from arbitrary external text but no permission model, repo allowlist, rate limit, or abuse handling is specified ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:204)). Fix: add trigger authz, per-repo allowlists, dedupe keys, rate limits, and “dry-run pending approval” mode.

- Medium: context packs say “ONLY diff-relevant source paths” but no algorithm is specified; bad file selection will make reviewers miss cross-file regressions ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:388)). Fix: define a deterministic context builder using changed files, imports/references, ownership rules, tests, and reviewer-requested expansion.

- Medium: multi-provider failback says “never cross vendors mid-task” but the router also overflows subscription to API-key lanes and uses cross-model ping-pong ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:336), [DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:615)). Fix: separate retry/failback policy from role-routing policy and record which transitions are allowed for each failure class.

- Low: the UI design section is over-prescriptive while core operational invariants are still missing; this will burn early effort on polish before correctness. Fix: lock only essential layout/status tokens in V1 and move full design-review automation to after the core run/review loop.

VERDICT: REVISE
### Claude's response (round 1)
Accepted 22 of 24 findings, integrated as new §3.12 "Hardening revisions" (21 numbered amendments that override conflicting earlier text) + rewrote build order steps 0-3 and V1.5:
- ACCEPTED all 3 criticals: auto-merge deferred to V1.5 behind branch protection + CI verification + verdict audit; host-side forge service owns all credentials (agent env has no gh auth, worktree remote credential-free); per-run ephemeral HOME in V1 (bwrap-lite).
- ACCEPTED: provider conformance tests, schema-repair wrapper for CLI verdicts, subscription lanes as opaque capacity pools (replaces speculative quota tracking), thread as append-only event stream with anchored findings (SHA + hunk context), full state machine as step-0 artifact, SQLite writer discipline, atomic task claiming, branch freshness gate, widened prompt-injection scope + test suite, break-glass authz, trigger authz, deterministic context-pack builder, failback-vs-routing policy split, hard wall-clock budgets with advisory token caps, events-only transcript, eval outside agent workspace, task schema in skeleton, settings registry deferred to V1.5 (config file + read-only UI in V1).
- PARTIALLY REJECTED (2): (a) full container isolation in V1 — ephemeral HOME + locks + no-credentials env covers the named attack vectors at a fraction of the cost; tank runs this trust model in production; containers stay V3. (b) "UI design over-prescriptive" — design tokens stay locked in V1 (explicit owner requirement; cheap), but accepted moving design-review automation and polish passes after the core loop.

## Round 2 — Codex

**Remaining Findings**

- Critical: §3.12.3 still puts provider auth material inside the agent-visible `$HOME` while explicitly deferring network policy to V3, so a prompt-injected shell-capable agent can read Claude/Codex/Gemini credentials and exfiltrate them even if forge creds are gone. Fix: V1 `bwrap-lite` must include an agent-invisible auth broker or read-only auth mount plus egress allowlist/proxy; otherwise disable unattended runs on untrusted repos.

- Critical: “bwrap-lite” is not specified enough to be a security boundary ([DARK-FACTORY-BLUEPRINT.md](/Users/cyberkoko/Desktop/SOFTWARE%20FACTORY/DARK-FACTORY-BLUEPRINT.md:706)); if it is only ephemeral `$HOME`, it does not prevent reads of `/home`, `/tmp`, SSH agents, local sockets, system files, or sibling worktrees. Fix: define the exact bubblewrap invocation/invariants in V1: private mount namespace, allowed binds, private `/tmp`, no host home, no SSH agent, no inherited dangerous env, and test it.

- High: session resume conflicts with per-run ephemeral `$HOME`; Claude/Codex sessions are provider-owned files keyed by cwd/session layout, and the plan does not define capture/restore/locking across coder-reviewer ping-pong rounds. Fix: add a V1 session-store service that imports/exports provider session files per run, rewrites cwd paths where needed, and locks by `{provider, session_id}`.

- High: host-side forge push is safer, but the host pushes from an agent-mutated worktree; the agent can alter git config, hooks, submodules, LFS pointers, generated files, or commit metadata before the trusted process pushes. Fix: have the forge service use explicit remote URLs, ignore worktree git config/hooks, verify branch/ref/base, run secret scanning, and push only validated commits.

- High: auto-merge unlock says “branch protection + CI status verification” but not how the system proves those protections exist or that status checks are from trusted GitHub Apps/workflows. Fix: add an auto-merge preflight that verifies rulesets/branch protection, required checks, trusted check-run app IDs, fresh head SHA, and no bypass permissions on the bot token.

- High: V1 still opens PRs before real sandboxing and before provider capacity/budget enforcement beyond wall-clock; a compromised agent can burn subscription quota or API-provider auth without touching forge credentials. Fix: add per-provider process/concurrency limits, per-run kill budgets, and provider-auth revocation/rotation procedures to V1, not V1.5.

- Medium: §3.12.10 defines thread events but omits retention/redaction policy; transcripts can contain secrets, auth URLs, prompt payloads, terminal output, and proprietary code, then become searchable/auditable forever. Fix: classify event payloads, redact known secret patterns before persistence, and set per-project retention/export controls.

- Medium: branch freshness gate before PR open/review/merge is good, but dependent task sequencing still needs a merge-confirmed base SHA; otherwise downstream tasks can start from a PR branch that later changes or is closed. Fix: make dependencies unblock only on confirmed merge commit SHA and record each task’s base SHA in the state machine.

- Medium: provider conformance tests gate capabilities, but the build order puts the “full provider matrix” in V1.5 while V1 already depends on Claude Code coder + Codex reviewer. Fix: require conformance tests for the two V1 providers before step 2/3, not only for the later matrix.

- Medium: the partial rejection cites tank’s production trust model, but tank delegates PR/merge to Claude in places and is Claude-only; it is not evidence that multi-provider credential isolation is safe. Fix: treat tank as a tmux/lifecycle reference only and write a Nightshift-specific threat model for multi-provider auth before V1.

VERDICT: REVISE
### Claude's response (round 2)
Accepted ALL 10 findings as §3.12 amendments 22-31 + build order updates:
- bwrap-lite fully specified (private mount ns, explicit binds, no SSH agent, env allowlist, automated invariant test) — §3.12.22
- V1 egress allowlist (uid-scoped nftables/proxy to provider APIs + GitHub); unattended runs on untrusted repos disabled until active — §3.12.23. Honest framing: CLI must read its own auth, so containment = network policy.
- Session-resume conflict resolved via per-TASK (not per-run) isolated HOME — sessions persist across ping-pong rounds naturally; session-store service is the V2 cross-machine path — §3.12.24
- Forge service distrusts worktree (explicit remote, hooks disabled, config ignored, secret scan, ref validation; submodule/LFS changes need reviewer ack) — §3.12.25
- Auto-merge preflight verifies protections/trusted check apps/fresh SHA/no bypass on every merge — §3.12.26
- Provider concurrency caps + kill budgets + rotation procedures moved into V1 — §3.12.27
- Thread event redaction/retention — §3.12.28
- Dependencies unblock on merge-confirmed SHA only — §3.12.29
- claude-code/codex conformance tests before build steps 2-3 — §3.12.30
- Nightshift-specific threat model as step-0 artifact; tank reframed as tmux/lifecycle precedent only — §3.12.31
No rejections this round.

## Round 3 — Codex

Re-review result: no material implementation blockers remain. The round-2 amendments now define the V1 security boundary, egress control, session continuity, trusted forge push path, auto-merge preflight, provider limits, data retention, dependency unblocking, V1 provider conformance, and threat-model gate clearly enough to start with step 0.

The remaining risks are implementation-quality risks, not plan-shape blockers: the step-0 threat model and schema/state-machine review must be treated as a real gate, and the bwrap/egress invariant tests must fail closed before any unattended untrusted run is allowed.

VERDICT: APPROVED
### Outcome
APPROVED after 3 rounds. Codex's closing condition: treat the step-0 threat model + schema/state-machine review as a real gate, and bwrap/egress invariant tests must fail closed before any unattended untrusted run.
