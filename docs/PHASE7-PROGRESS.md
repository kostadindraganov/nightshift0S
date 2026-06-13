# Phase 7 (V3) — build progress (COMPLETE on macOS)

2026-06-13. All code-able V3 units built, verified, and wired. **1160 tests pass, typecheck
clean, frontend bundles (44 modules).** Only GATE-5 (Linux runtime) remains.

Foundation (orchestrator): config blocks added (container/workers/cliUpdate/preview/
selfOptimize + providers.cma{Enabled,Model} + tournament.tiebreakerProvider); config.test
leaf count 38→57.

| ✓ | Unit | Agent files | Model | Tests |
|---|------|-------------|-------|-------|
| ✅ | 7.1 Container isolation per run | src/sandbox/container.ts(+test) | Sonnet | 6 |
| ✅ | 7.2 Multi-VM workers (registry/lease) | src/scheduler/workers.ts(+test)+workersRoutes.ts | Sonnet | 6 |
| ✅ | 7.3 CLI auto-update + status | src/providers/cliUpdate.ts(+test)+cliUpdateRoutes.ts | Sonnet | 6 |
| ✅ | 7.4 Preview environments | src/preview/{preview,previewRoutes}.ts(+test) | Sonnet | 7 |
| ✅ | 7.5 CMA provider plugin | src/providers/cma.ts(+test) | Sonnet | 8 |
| ✅ | 7.6 Prompt self-optimization | src/experiment/promptOptimize.ts(+test) | Opus | 5 |
| ✅ | 7.7 Three-model tiebreaker | src/review/tiebreaker.ts(+test) | Opus | 6 |
| ✅ | 7.8 UI — Infra tab | web/views/InfraView.tsx | Haiku | — |

Orchestrator wiring done: registry.ts (CMA driver), routes.ts (workers/cliUpdate/preview
routes), web App/AppShell (Infra tab) + api/types helpers, package.json (src/preview glob).
Integration repair: cliUpdate/workers null-safety for noUncheckedIndexedAccess; string path
param → `ctx.params.id ?? ""` (house idiom).

GATE-5 (Linux-only, honest label): real docker/podman run-spawn, remote worker daemons,
live CLI update exec, live preview deploy/proxy/DNS, live CMA API + conformance, live
third-reviewer spawn. Config wires each via injected deps; all default OFF / fail-closed.
