# Code reuse map

What was copied from the source projects (in `../`) and how it is used.

| Location here | Source | How it's used |
|---|---|---|
| `vendor/sandcastle/` | sandcastle 0.7.0 (`@ai-hero/sandcastle`, full src + ADRs, MIT-style — verify license before publishing) | **Embedded library** — agent providers (claudeCode/codex/pi/opencode/cursor), Orchestrator, worktree manager, structured Output, timeouts. Imported as workspace dep. We extend with: gemini/antigravity providers, crypto-random temp-branch suffix (known gap), tmux wrapper. |
| `src/worktree/` | sandcastle `src/WorktreeManager.ts` (ADR-0003/0004/0007/0018) | **Pattern PORTED, not embedded** (task 2.2). sandcastle's WorktreeManager is internal (not in its public `exports`) and Effect-based; Nightshift is deliberately Effect-free (plain Promise + bun:sqlite). Reimplemented the correctness properties natively (O_EXCL PID-stale lock, crypto-random suffix, `NO_CONFIG_LOCK_FLAGS`, ff-only reuse, ADR-0004 no auto-teardown) with `ns/<task_id>-<slug>-<rand>` naming under `.nightshift/worktrees/`. sandcastle's *public* Promise API can still be embedded for the run service (2.5). **Revisit if owner prefers embedding sandcastle's Effect worktree directly.** |
| `reference/warren/events.ts` | warren `src/runs/events.ts` | **Adapt into `src/events/`** — RunEventBroker (bounded buffers, drop-oldest) + subscribe→replay→tail dedup pattern. |
| `reference/warren/db/sqlite.ts`, `columns.ts` | warren db schema | **Pattern reference** for Drizzle schema layout + dialect-agnostic columns file (our schema is in docs/SPEC-SCHEMA.md). |
| `reference/warren/scheduler.ts` | warren | **Adapt** — single-flight tick loop for triggers/pollers. |
| `reference/warren/supervisor/main.ts` | warren | **Adapt** — child restart budget (5-in-60s, exp backoff) if we split processes; otherwise systemd only. |
| `reference/warren/errors.ts`, `ids.ts` | warren core | **Adapt** — typed error model + id generation. |
| `ops/reference/deploy.sh` | tank | **Adapt** — idempotent SSH deploy: service user creation, native CLI installs, hooks registration, systemd render+restart. |
| `ops/reference/tank.service` | tank | **Adapt** — systemd unit template (non-root, PATH pinning). |
| `ops/reference/hook.sh` | tank | **Adapt** — Claude Code lifecycle-hook → API event bridge one-liner. |
| `ui-reference/kanban/` | localforge components | **Adapt into `ui/`** — dnd-kit board, columns, cards, ref-mirror drag handlers, optimistic update + revert. |
| `ui-reference/app-shell/`, `theme/` | localforge | **Adapt** — shell/layout scaffolding; restyle to Nightshift design tokens (BLUEPRINT §3.8). |
| `ui-reference/features.ts`, `db/` | localforge lib | **Pattern reference** — dependency readiness (completed-set O(1)), BFS cycle check, demotion. |
| `docs/BLUEPRINT.md` | this planning session | The spec. §3.12 overrides earlier sections. |
| `docs/PLAN-REVIEW-LOG.md` | Codex adversarial review | Why the spec looks the way it does (3 rounds → APPROVED). |

Rules:
- `vendor/` is imported, not edited (changes go upstream-style via patches noted here).
- `reference/` and `ui-reference/` are raw copies for adaptation — code moves OUT of them into `src/`/`ui/` with attribution headers, then the copy can be deleted.
