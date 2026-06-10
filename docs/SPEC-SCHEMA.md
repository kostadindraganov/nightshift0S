# Nightshift — Database Schema (step-0 gate artifact)

Status: v1.0, 2026-06-10. Per BLUEPRINT §3.12.10/.11/.20. SQLite (WAL) via
`bun:sqlite` + Drizzle; Postgres dialect mirrors later (warren R-13 pattern —
see `reference/warren/db/`). Naming/state tuples live in one dialect-agnostic
`columns.ts` (copied pattern).

## SQLite discipline (§3.12.11)
- `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
  PRAGMA synchronous=NORMAL;`
- **One writer queue**: all writes go through a single serialized queue
  (module-level); reads are unrestricted. SQLITE_BUSY → bounded retry with
  jitter, then surfaced.
- Wal checkpoint: `PRAGMA wal_checkpoint(TRUNCATE)` on idle tick when WAL
  > 64 MB.
- Transactions: short and explicit; never span an await on agent I/O.

## Tables

### projects
| col | type | notes |
|---|---|---|
| id | int pk | |
| name | text | |
| repo_url | text | |
| default_branch | text | default 'main' |
| settings_json | text | per-project overrides (V1 file-sourced, mirrored read-only) |
| created_at / updated_at | text iso | |

### tasks
| col | type | notes |
|---|---|---|
| id | int pk | |
| project_id | fk projects CASCADE | |
| title / description / acceptance_criteria | text | criteria = testable assertions (§3.5) |
| state | text | draft\|backlog\|ready\|coding\|review\|approved\|merging\|needs_human\|done\|failed\|cancelled |
| priority | int | localforge demotion semantics |
| category | text | functional\|style\|chore\|security |
| risk_tier | text | trivial\|lite\|full (Cloudflare) |
| branch | text null | `ns/<task_id>-<slug>` |
| base_sha | text null | merge-base recorded at claim (§3.12.12/29) |
| merge_sha | text null | set ⟺ done |
| claimed_by | int null fk runs | active claim |
| round | int default 0 | current review round |
| routine_id | int null fk routines | provenance |
| created_at / updated_at | text | |

Indexes: (project_id, state), (project_id, priority).
Partial unique: `one_active_run_per_task` on runs(task_id) WHERE state NOT IN (terminal set).

### task_dependencies
(task_id fk, depends_on_task_id fk, UNIQUE(task_id, depends_on_task_id)).
Cycle check (BFS) at insert (localforge). Readiness = all deps merge_sha NOT NULL.

### runs
| col | type | notes |
|---|---|---|
| id | int pk | |
| task_id | fk null | null for utility/experiment routine runs |
| kind | text | coder\|reviewer\|planner\|judge\|utility\|experiment |
| provider / model | text | resolved at spawn |
| auth_lane | text | subscription\|api_key\|local |
| state | text | queued\|starting\|running\|awaiting_input\|background_waiting\|finishing\|succeeded\|failed\|killed\|interrupted |
| session_id | text null | provider session (resume across rounds, per-task HOME §3.12.24) |
| worktree_path / tmux_session / home_path | text null | |
| head_sha | text null | commit the run produced/reviewed |
| exit_reason | text null | classified (auto-triage input) |
| tokens_in / tokens_out | int null | |
| cost_usd | real null | |
| priced | int bool | cost telemetry proven (§3.12.15) |
| started_at / ended_at | text | wall-clock budget enforcement on this |

### thread_events  (append-only — the task conversation, §3.12.10)
| col | type | notes |
|---|---|---|
| id | int pk | |
| task_id | fk CASCADE | |
| seq | int | monotonic per task; UNIQUE(task_id, seq) |
| kind | text | message\|finding\|rebuttal\|verdict\|system\|human\|artifact |
| actor | text | `coder:claude-code`, `reviewer:codex`, `human:<user>`, `system` |
| round | int | |
| run_id | int null fk | |
| idempotency_key | text UNIQUE null | dedupes hook/retry double-delivery |
| payload_json | text | redacted before persist (§3.12.28) |
| artifact_refs | text null | json list of artifact paths/ids |
| redacted | int bool | |
| created_at | text | |

No UPDATE/DELETE on this table except redaction (`payload_json` overwrite +
`redacted=1`) and retention pruning.

### findings  (anchored review findings, §3.12.10)
| col | type | notes |
|---|---|---|
| id | int pk | |
| task_id / round / run_id | fk/int | round introduced |
| severity | text | critical\|high\|medium\|low\|nit |
| confidence | real | 0..1 |
| commit_sha | text | head SHA reviewed |
| file_path_old / file_path_new | text | survives renames |
| hunk_context | text | patch context anchor (survives line drift) |
| description / suggestion | text | |
| resolution_state | text | open\|fixed\|rebutted\|withdrawn\|accepted_risk |
| resolved_round | int null | |

### events  (global event log — warren pattern)
(id pk, project_id fk null, run_id fk null, task_id fk null, seq int,
kind text, payload_json text, ts text). Write-through before broker publish;
broker is in-memory bounded (1024, drop-oldest + dropped counter). Streaming:
subscribe → replay history → tail, dedup by seq.

### providers
(id, name, kind cli|api, auth_mode subscription|api_key, enabled bool,
capabilities_json — **written only by conformance test runs** §3.12.13,
concurrency_cap int, cooldown_until text null — capacity-pool state §3.12.14,
circuit_state text closed|open|half_open, last_error text null).

### prompts  (versioned org code, §3.8)
(id, name, version int, body text, created_by, created_at;
UNIQUE(name, version)). Active version pinned per routine/role.

### routines
(id, project_id fk null, name, kind task|experiment, prompt_name, params_json,
provider_pref, rubric text null, budget_json — wall-clock + advisory tokens,
review_policy full|light|none, enabled).

### triggers
(id, routine_id fk, kind manual|cron|webhook|chat, schedule text null,
authz_json — allowlist/rate-limit/dedupe §3.12.6, dry_run_default bool,
enabled, last_fired_at). Fire history → events table.

### experiment_ledger  (§3.11)
(id, routine_run_id fk runs, iteration int, commit_sha text, metric_name text,
metric_value real, status keep|discard|crash, memory_note text null,
description text, created_at). Renders as timeline + metric chart.

### settings  (V1: read-only mirror of config file; V1.5: editable registry)
(scope global|project|routine, scope_id int null, key text, value_json text,
updated_by, updated_at, UNIQUE(scope, scope_id, key)). Secrets are NOT here —
they live in the OS keyring/sealed store (§3.12.7); this table stores
references only.

## Artifacts
Filesystem under `data/artifacts/<task_id>/…` (screenshots, run.log, patches);
DB stores refs only. Retention policy per project (§3.12.28).
