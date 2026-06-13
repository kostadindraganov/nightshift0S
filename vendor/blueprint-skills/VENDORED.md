# Vendored: blueprint-skills

Workflow skills mounted into spawned coding-agent worktrees so each agent
follows a disciplined `design-doc → spec → plan → implement → review` pipeline
instead of improvising its process.

## Source

- Upstream: https://github.com/owainlewis/blueprint
- Commit: `f3f2f31bf23314c047ff66dbceb50f0c719dc111`
- Date: 2026-06-12
- License: see upstream repo.

## What is here

- `skills/*/SKILL.md` — the 15 standalone workflow skills.
- `AGENTS.md` — the two-flow (Decide / Deliver) overview + definition-of-ready.
- `guides/labels.md`, `guides/loops.md` — label state machine + unattended-loop
  reference (used as the spec for the nightshift loop guardrails, not mounted).
- `agents/code-reviewer.md` — fresh-context adversarial reviewer.

## How nightshift uses it

The mount seam in `src/runs/spawn.ts` copies a configured subset of `skills/`
into each spawned agent's worktree under `.nightshift/skills/` and references it
in the agent prompt. This is provider-agnostic (Claude Code / Codex / Gemini).

This is a vendored copy: edits go upstream, not here. Re-sync by re-cloning the
upstream commit and copying `skills/`, `guides/`, `agents/`, `AGENTS.md`.
