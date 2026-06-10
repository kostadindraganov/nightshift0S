# Nightshift — Threat Model (step-0 gate artifact)

Status: v1.0, 2026-06-10. Per BLUEPRINT §3.12.31. Scope: single Linux VM,
non-root service user, multi-provider CLI + API agents, GitHub-first.

## Assets
A1. Provider credentials — subscription login state (`~/.claude`, `~/.codex`,
    Gemini auth) and API keys. A2. Forge credentials (GitHub token / App).
A3. Source code of managed repos (incl. private). A4. The factory's own
integrity (DB, prompts, eval harnesses). A5. Money (token spend, subscription
quota). A6. Whatever the VM can reach on the network.

## Actors / trust levels
- **Operator (you)** — trusted.
- **Control plane** (Bun process, forge service, schedulers) — trusted; owns
  A2, brokers everything.
- **Agent runs** (CLI processes in tmux) — **semi-trusted**: they execute
  arbitrary shell in their workspace and read text from untrusted sources.
  Treated as potentially prompt-injected at all times.
- **External content** — repo files, diffs, issues, PR comments, webhooks —
  **untrusted input**, always quoted data (§3.12.4).

## Trust boundaries
B1. Agent workspace ↔ host filesystem (bwrap-lite: private mount ns, explicit
    binds, per-task HOME, no host /home, no SSH agent, env allowlist —
    §3.12.22/24; invariant tests fail closed).
B2. Agent process ↔ network (uid-scoped egress allowlist: provider APIs +
    GitHub only — §3.12.23; until active, unattended untrusted repos OFF).
B3. Agent ↔ forge (agents have zero forge credentials; host-side forge
    service distrusts the worktree: explicit remote, hooks disabled, config
    ignored, secret-scan, ref validation — §3.12.2/25).
B4. External text ↔ agent instructions (system prompts isolated; boundary-tag
    stripping; injection test suite — §3.12.4).
B5. Agent ↔ eval harness (experiment evals run outside the agent workspace,
    read-only checkout — §3.12.8).
B6. UI/API ↔ world (bearer token, constant-time compare; triggers have
    authz/allowlists/rate limits/dry-run default — §3.12.6).

## Attack vectors → mitigations
| # | Vector | Mitigation | Residual risk |
|---|---|---|---|
| T1 | Prompt-injected agent exfiltrates provider creds (it can read its own auth by necessity) | B1 limits to ONE provider's material; B2 egress allowlist blocks non-provider destinations; provider rotation procedure (§3.12.27) | Exfil TO the provider's own API (e.g. encode into a chat). Low value, detectable in transcripts; accept + monitor |
| T2 | Injected agent pushes/merges malicious code | B3 (no forge creds), verdicts bound to head SHA, auto-merge preflight (§3.12.26), V1 human merge, cross-model review | Reviewer model deceived by subtle backdoor; mitigated by security-specialist pass + human merge in V1 |
| T3 | Malicious repo content steers the REVIEWER (approve-everything injection) | B4: diff/comments are quoted data; reviewer prompts isolated; injection suite includes hostile-diff cases; approval requires schema-valid verdict bound to SHA | Novel injections; periodic red-team routine |
| T4 | Agent games the eval/metric (Goodhart) | B5: immutable harness outside workspace; metric parsing host-side | Metric overfitting (legit but useless wins) — human reviews experiment ledger |
| T5 | Agent corrupts factory state (DB, prompts, locks) | B1: DB/config/prompt store not bind-mounted into workspaces; settings changes only via API with audit | Bugs in mount config — invariant tests |
| T6 | Cross-task contamination (task A reads/edits task B's worktree or session) | Per-task HOME + worktree locks + private mount ns | tmux server shared per service user — V3 hardening |
| T7 | Runaway spend (loops, retry storms) | Wall-clock kill budgets (hard), provider concurrency caps, capacity-pool cooldowns, circuit breakers, advisory token caps where priced (§3.12.14/15/27) | Subscription burn inside caps — visible in analytics |
| T8 | Forged webhook/chat trigger creates tasks | B6 authz + repo allowlist + dedupe + rate limit + dry-run default for external sources | Compromised allowlisted account → dry-run gate |
| T9 | Secrets leak into transcripts/logs/PRs | Redaction before persistence (§3.12.28); secret-scan outgoing diffs (§3.12.25); audit events never carry secret values (§3.12.7) | Unknown secret formats — pattern list maintained |
| T10 | VM compromise (root) | Out of scope: same-VM root = plaintext for everything (§3.12.7, documented honestly). Keyring/KMS raises the bar; backups + rotation limit blast radius | Accepted |
| T11 | Supply chain via agent-installed deps in worktree | CI gate runs in same sandbox profile; lockfile-change findings flagged to reviewer; submodule/LFS changes need explicit ack (§3.12.25) | Deeper SCA scanning — V2 |
| T12 | Break-glass abuse | Allowlisted identity + exact signed syntax + fresh head SHA + immutable audit (§3.12.5) | Insider with allowlisted identity — audit trail |

## Fail-closed requirements (Codex approval condition)
1. bwrap invariant test fails → agent spawning disabled (not "warn").
2. Egress allowlist inactive → unattended runs on untrusted repos refused.
3. Schema-invalid verdict after repairs → needs_human, never default-approve.
4. Auto-merge preflight cannot verify protections → human merge.
5. Secret-scan failure on outgoing diff → push blocked.

## Review cadence
Re-review this document at each phase gate (V1 → V1.5 → V2 → V3) and after
any incident; security-review routine runs the injection suite weekly.
