# Phase 3 + Phase 4 Closeout Summary

**Date:** 2026-06-12
**Status:** Phase 3 COMPLETE (review path wired); Phase 4 PARTIAL (intake & planner wired, bootstrap chat UI pending)

---

## Phase 3: Review Path (Ping-Pong Loop)

### What Was Built

#### Core Services
- **Thread service** (`src/thread/thread.ts`): Append-only audit log of coder↔reviewer interaction
  - Seq-allocated gap-free ordering (same discipline as EventLog)
  - Idempotency keys for dedup under hook retry
  - Redaction pass before persist (secrets never leave process)
  - Emits `thread.appended` / `finding.updated` events

- **Verdict engine** (`src/review/engine.ts`): One-round review verdict handler
  - Pluggable judge (Codex/Gemini CLI or scripted fake)
  - XML-tag extraction + schema-repair (fail-closed)
  - Verdict validation (VerdictFinding[] + VerdictResolution[])

- **Judge** (`src/review/judge.ts`): Wrapper around provider CLI invocation
  - Structured output (required cap for reviewers)
  - Cost tracking + result emission
  - Prompt assembly from prior findings + new diff

- **Findings** (`src/review/findings.ts`): Finding anchoring + hunk extraction
  - Severity + confidence + file path + line number + hunk context
  - Keyed by commit SHA for cross-round lookup
  - Resolution lifecycle: open → (fixed|rebutted|withdrawn|accepted_risk)

- **Orchestrator** (`src/orchestrator/review.ts`): Ping-pong round coordination
  - Runs up to K rounds (configurable max)
  - Resumes coder in same session (per-task HOME preserves session files)
  - Delta re-review: shows prior findings + resolution states + new diff only
  - Escalates deadlock to needs_human

#### UI Components
- **TaskDetailView** (`web/views/TaskDetailView.tsx`): Task detail page
- **ThreadView** (`web/components/thread/ThreadView.tsx`): Thread message display + live SSE updates
- **VerdictPanel** (`web/components/thread/VerdictPanel.tsx`): Verdict rendering
- **FindingsPanel** (`web/components/thread/FindingsPanel.tsx`): Findings list + resolution actions

#### Safety & Hygiene
- **Injection test suite** (`src/review/injection.test.ts`): Hostile diff/comment fixtures
  - Verdicts must not flip under prompt-injection attacks
  - Suite runs in CI (marked in test name)
- **Sanitize** (`src/review/sanitize.ts`): Prompt-injection defense (BLUEPRINT §3.12.4)

### Test Coverage

**Total:** 385 tests across 34 files, all passing (0 fail)

**New test suites (Phase 3):**
- `src/thread/thread.test.ts`: Append, idempotency, redaction, finding lifecycle
- `src/review/engine.test.ts`: Verdict parsing, validation, fail-closed on malformed
- `src/review/injection.test.ts`: Prompt-injection safety

**Phase 4 tests (preliminary):**
- `src/planner/planner.test.ts`: Plan parsing, cycle detection, fail-closed
- `src/planner/bootstrap.test.ts`: Project bootstrap, fakes-only

### The Ping-Pong Flow (Verified)

```
1. coder → draft task (state: coding)
2. orchestrator/coder.ts: push + PR → coding→review
3. orchestrator/review.ts: spawn reviewer (codex CLI)
4. judge → PR diff + prior findings → structured verdict
5. Thread events logged (idempotent)
6. Finding anchors persisted (SHA + hunk context)
7. Verdict outcome:
   - "approved" → task→approved, ready for merge
   - "revise" + round < K → task→coding (resume coder), emit round+1 context
   - Round ≥ K or mutual deadlock → task→needs_human (human resolves in UI)
8. Human: click "Promote to Approved" → task→approved
9. orchestrator/coder.ts: merge + dependents unblock
```

All paths tested with:
- Scripted reviewer (fake judge that returns canned verdicts)
- Scripted coder (fake spawn that touches worktree files)
- Real git (actual worktree clone/branch/merge)
- Real DB (SQLite with real transactions)
- Real state machine (guarded transitions, cycle check)

---

## Phase 4: Planner + Intake (Partial)

### What Was Built

#### Planner Service
- **Planner** (`src/planner/planner.ts`): Free-text plan → tasks with dependencies
  - Pluggable LLM (Codex/Gemini CLI or scripted fake)
  - Plan JSON in `<plan>…</plan>` tags (schemaRepair extraction)
  - Fail-closed: malformed response → no tasks persisted
  - In-memory cycle check before first INSERT
  - Acceptance criteria (testable assertions per BLUEPRINT §3.5)

- **Bootstrap** (`src/planner/bootstrap.ts`): Project bootstrap pattern
  - Planner call on project description
  - Task creation + dependency edges
  - Returns array of (id, title) tuples

#### UI
- **DraftColumn** (`web/components/kanban/DraftColumn.tsx`): To-Do lane
  - Renders draft tasks (state: draft)
  - "Promote" action → POST /tasks/:id/promote → draft→backlog
  - Drop-target disabled (drafts enter via import/creation, not drag)

### Test Coverage

**Phase 4 tests (preliminary):**
- `src/planner/planner.test.ts`: Plan parsing, cycle detection, task creation
- `src/planner/bootstrap.test.ts`: Bootstrap happy path, fail-closed on bad planner response

Both suites included in the 385 passing tests.

---

## Deploy-Pending List

### Live CLI Spawn (Linux Host Required)

1. **Reviewer-CLI invoke** (Phase 3, task 3.2)
   - Current: scripted fake judge in tests
   - Deploy: real Codex/Gemini CLI spawn in tmux
   - Files affected: `src/review/judge.ts` (remove fake, wire real spawn)
   - Impact: ProviderDriver for structured-output reviewers; cost tracking

2. **Planner-CLI invoke** (Phase 4, task 4.1)
   - Current: scripted fake planner in tests
   - Deploy: real Codex/Gemini CLI spawn in tmux
   - Files affected: `src/planner/planner.ts` (remove fake, wire real spawn)
   - Impact: ProviderDriver integration; plan prompt tuning

3. **Coder-CLI spawn resumption** (Phase 2, task 2.5)
   - Current: scripted fake coder, real tmux on macOS
   - Deploy: real Claude Code CLI spawn in tmux on Linux
   - Files affected: `src/runs/spawn.ts` + `ops/hook.sh` (symlink → Claude Code binary)

### UI Features

4. **xterm.js live-attach** (Phase 2, task 2.5)
   - Current: not built
   - Deploy: WebSocket stream from tmux (xterm.js frontend)
   - Files affected: `src/server/terminalRoutes.ts` (new), `web/components/TerminalView.tsx` (new)
   - Related: TaskDetailView needs tab for live terminal, event stream plumbing

5. **Project bootstrap chat** (Phase 4, task 4.3)
   - Current: bootstrap function exists, no UI
   - Deploy: modal or dedicated view to paste plan text
   - Files affected: `web/views/IntakeView.tsx` (new), `App.tsx` (route + state)
   - Related: POST /projects/:id/bootstrap-chat endpoint

### CI/GitHub Runtime

6. **Live PR diff fetch** (Phase 2, task 2.7)
   - Current: stale-base check works; CI gate stubbed with fake
   - Deploy: real GitHub Checks API polling
   - Files affected: `src/gate/ciGate.ts` (remove fake CiClient)
   - Requires: GITHUB_TOKEN on host, GH CLI or Octokit

7. **Live push + PR creation** (Phase 2, task 2.6)
   - Current: secret-scan + distrust flags verified; forge.prepareAndOpenPR() stubbed
   - Deploy: real git push + gh pr create
   - Files affected: `src/forge/push.ts` + `src/forge/pr.ts` (remove fakes)
   - Requires: remote (GitHub), GH CLI, host GITHUB_TOKEN

---

## Verify Checklist (macOS, 2026-06-12)

- ✓ `bun run typecheck`: clean (0 errors)
- ✓ `bun run test`: 385/385 pass (0 fail)
- ✓ Phase 3 tasks 3.1–3.5: all marked ☑ (built & logic-tested)
- ✓ Phase 4 tasks 4.1–4.3: marked ☑ (partial; chat UI pending)
- ✓ GATE 3 status: ◑ (review path wired; CLI spawn + xterm.js pending)
- ✓ GATE 4 status: ◑ (planner wired; bootstrap chat UI pending)
- ✓ All deploy-pending items documented above

---

## Next Steps (Linux Host Deployment)

1. **Prepare Linux VM:**
   - Clone repo (or pull latest from main)
   - Install Bun + Node.js
   - Set GITHUB_TOKEN + Codex API keys
   - Bind GitHub webhook to localhost (reverse tunnel or ngrok)

2. **Wire live providers:**
   - Remove fakes in `src/review/judge.ts`, `src/planner/planner.ts`
   - Wire ProviderDriver for CLI spawn
   - Test real Codex/Gemini invocation in isolation

3. **Deploy live endpoints:**
   - `src/server/terminalRoutes.ts` (WebSocket for xterm.js)
   - `web/components/TerminalView.tsx` (live attach UI)
   - TaskDetailView: add "Terminal" tab

4. **Bootstrap chat UI:**
   - `web/views/IntakeView.tsx` (text input, paste plan)
   - POST `/projects/:id/bootstrap-chat` (call planner)
   - Emit draft tasks to board

5. **Live end-to-end test:**
   - Paste a simple plan ("Fix a typo in README")
   - Watch task → code → PR → review → merge (by hand) → done
   - Verify all three CLIs spawn and completes, no orphans

---

## Files Added (Phase 3 + 4)

### Thread
- `src/thread/thread.ts`
- `src/thread/thread.test.ts`
- `src/thread/redaction.ts`

### Review
- `src/review/engine.ts`
- `src/review/engine.test.ts`
- `src/review/judge.ts`
- `src/review/verdict.ts`
- `src/review/findings.ts`
- `src/review/sanitize.ts`
- `src/review/injection.test.ts`

### Orchestrator (extended)
- `src/orchestrator/review.ts`
- `src/orchestrator/review.test.ts`

### Planner (Phase 4)
- `src/planner/planner.ts`
- `src/planner/planner.test.ts`
- `src/planner/bootstrap.ts`
- `src/planner/bootstrap.test.ts`

### UI (Phase 3)
- `web/views/TaskDetailView.tsx`
- `web/components/thread/ThreadView.tsx`
- `web/components/thread/VerdictPanel.tsx`
- `web/components/thread/FindingsPanel.tsx`

### UI (Phase 4)
- `web/components/kanban/DraftColumn.tsx`

### API Routes (extended)
- `src/server/reviewRoutes.ts` (Thread + Finding endpoints)

---

## Commit Message

```
Phase 3 + 4 closeout: review loop + planner wired (385 tests ✓)

- Thread service (append-only audit log, idempotency, redaction)
- Verdict engine (structured judge call, fail-closed parsing)
- Findings anchoring (SHA + hunk context, resolution lifecycle)
- Ping-pong orchestrator (coder↔reviewer rounds, delta re-review, escalate)
- Task detail UI (ThreadView + VerdictPanel + FindingsPanel)
- Prompt-injection test suite (hostile diff/comment fixtures)
- Planner service (plan text → tasks with dependencies, fail-closed)
- Draft lane UI (DraftColumn + promote flow)
- Project bootstrap (structured planner call)

All services tested with scripted fakes + real git/DB on macOS (385/385 tests).
DEPLOY-PENDING: live Codex/Gemini reviewer+planner CLI spawn (tmux), xterm.js
live-attach UI, bootstrap chat view, real GitHub push/PR/CI endpoints.
```
