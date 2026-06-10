# Nightshift

Autonomous software factory: plan in → tasks → kanban → coding agents (Claude
Code / Codex / Gemini CLIs + API providers) in isolated git worktrees → PR →
cross-model AI review ping-pong → merge. Runs on a Linux VM. Works while you
sleep.

- Spec: `docs/BLUEPRINT.md` (§3.12 = binding hardening amendments)
- Step-0 gate artifacts: `docs/SPEC-STATE-MACHINES.md`, `docs/SPEC-SCHEMA.md`,
  `docs/THREAT-MODEL.md`
- Adversarial plan review (3 rounds → APPROVED): `docs/PLAN-REVIEW-LOG.md`
- Code reuse from sibling projects: `REUSE.md`

Stack: TypeScript + Bun + SQLite (WAL) + Drizzle; sandcastle embedded
(`vendor/sandcastle`); React kanban UI; GitHub-first forge.
