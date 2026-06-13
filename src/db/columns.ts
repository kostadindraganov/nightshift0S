/**
 * Dialect-agnostic schema constants (warren R-13 pattern — see
 * `reference/warren/db/columns.ts`).
 *
 * Drizzle has no shared sqlite/pg table builder, so the shared layer lives at
 * the metadata level: enum tuples, type unions, and table/index name strings.
 * The SQLite physical schema (`./schema.ts`) imports these today; a Postgres
 * mirror can import the same constants later without drift.
 *
 * All enum columns are TS-only narrowing via drizzle's `{ enum: ... }` —
 * no SQL CHECK constraints (warren mx-2ab984 pattern). State-machine guards
 * live in application code; see docs/SPEC-STATE-MACHINES.md.
 *
 * Enum values come verbatim from docs/SPEC-SCHEMA.md v1.0.
 */

/** Task lifecycle (SPEC-SCHEMA `tasks.state`, SPEC-STATE-MACHINES §tasks). */
export const TASK_STATES = [
	"draft",
	"backlog",
	"ready",
	"coding",
	"review",
	"approved",
	"merging",
	"needs_human",
	"done",
	"failed",
	"cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** Run lifecycle (SPEC-SCHEMA `runs.state`). */
export const RUN_STATES = [
	"queued",
	"starting",
	"running",
	"awaiting_input",
	"background_waiting",
	"finishing",
	"succeeded",
	"failed",
	"killed",
	"interrupted",
] as const;
export type RunState = (typeof RUN_STATES)[number];

/**
 * Terminal run states. The partial unique index `one_active_run_per_task`
 * (SPEC-SCHEMA §tasks) is defined as WHERE state NOT IN this set — only one
 * non-terminal run may exist per task at a time.
 */
export const RUN_TERMINAL_STATES = [
	"succeeded",
	"failed",
	"killed",
	"interrupted",
] as const satisfies readonly RunState[];
export type RunTerminalState = (typeof RUN_TERMINAL_STATES)[number];

/** Run role discriminator (SPEC-SCHEMA `runs.kind`). */
export const RUN_KINDS = [
	"coder",
	"reviewer",
	"planner",
	"judge",
	"utility",
	"experiment",
] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** Provider auth lane resolved at spawn (SPEC-SCHEMA `runs.auth_lane`). */
export const AUTH_LANES = ["subscription", "api_key", "local"] as const;
export type AuthLane = (typeof AUTH_LANES)[number];

/** Append-only task conversation entry kinds (SPEC-SCHEMA `thread_events.kind`, §3.12.10). */
export const THREAD_EVENT_KINDS = [
	"message",
	"finding",
	"rebuttal",
	"verdict",
	"system",
	"human",
	"artifact",
] as const;
export type ThreadEventKind = (typeof THREAD_EVENT_KINDS)[number];

/** Review finding severity (SPEC-SCHEMA `findings.severity`). */
export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "nit"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** Review finding resolution lifecycle (SPEC-SCHEMA `findings.resolution_state`). */
export const FINDING_RESOLUTION_STATES = [
	"open",
	"fixed",
	"rebutted",
	"withdrawn",
	"accepted_risk",
] as const;
export type FindingResolutionState = (typeof FINDING_RESOLUTION_STATES)[number];

/** Cloudflare-style review depth tier (SPEC-SCHEMA `tasks.risk_tier`). */
export const RISK_TIERS = ["trivial", "lite", "full"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/** Task category (SPEC-SCHEMA `tasks.category`). */
export const TASK_CATEGORIES = ["functional", "style", "chore", "security"] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/** Provider integration kind (SPEC-SCHEMA `providers.kind`). */
export const PROVIDER_KINDS = ["cli", "api"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Provider auth mode (SPEC-SCHEMA `providers.auth_mode`). */
export const PROVIDER_AUTH_MODES = ["subscription", "api_key"] as const;
export type ProviderAuthMode = (typeof PROVIDER_AUTH_MODES)[number];

/** Provider circuit-breaker state (SPEC-SCHEMA `providers.circuit_state`, §3.12.14). */
export const CIRCUIT_STATES = ["closed", "open", "half_open"] as const;
export type CircuitState = (typeof CIRCUIT_STATES)[number];

/** Routine kind (SPEC-SCHEMA `routines.kind`). */
export const ROUTINE_KINDS = ["task", "experiment"] as const;
export type RoutineKind = (typeof ROUTINE_KINDS)[number];

/** Trigger source kind (SPEC-SCHEMA `triggers.kind`). */
export const TRIGGER_KINDS = ["manual", "cron", "webhook", "chat"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** Per-routine review policy (SPEC-SCHEMA `routines.review_policy`). */
export const REVIEW_POLICIES = ["full", "light", "none"] as const;
export type ReviewPolicy = (typeof REVIEW_POLICIES)[number];

/** Experiment iteration outcome (SPEC-SCHEMA `experiment_ledger.status`, §3.11). */
export const EXPERIMENT_STATUSES = ["keep", "discard", "crash"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/** Settings scope (SPEC-SCHEMA `settings.scope`). */
export const SETTING_SCOPES = ["global", "project", "routine"] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

/**
 * Physical table names. Centralized so a future Postgres mirror and any
 * drift check stay in lockstep — renaming a table is a one-line change here.
 */
export const TABLE_NAMES = {
	projects: "projects",
	tasks: "tasks",
	taskDependencies: "task_dependencies",
	runs: "runs",
	threadEvents: "thread_events",
	findings: "findings",
	events: "events",
	providers: "providers",
	prompts: "prompts",
	routines: "routines",
	triggers: "triggers",
	experimentLedger: "experiment_ledger",
	settings: "settings",
	// V2 (Phase 6): per-project agent memory (accumulated learnings).
	agentMemory: "agent_memory",
} as const;

/**
 * Physical index names. A future dialect mirror must use the same names and
 * column lists; SPEC-SCHEMA is the source of truth for which indexes exist.
 */
export const INDEX_NAMES = {
	tasksProjectState: "tasks_project_state_idx",
	tasksProjectPriority: "tasks_project_priority_idx",
	taskDependenciesUnique: "task_dependencies_unique_idx",
	runsTaskState: "runs_task_state_idx",
	// Partial unique: at most one non-terminal run per task (SPEC-SCHEMA §tasks).
	oneActiveRunPerTask: "one_active_run_per_task",
	threadEventsTaskSeq: "thread_events_task_seq_idx",
	threadEventsIdempotencyKey: "thread_events_idempotency_key_idx",
	eventsSeq: "events_seq_idx",
	eventsTask: "events_task_idx",
	promptsNameVersion: "prompts_name_version_idx",
	settingsScopeKey: "settings_scope_key_idx",
	// V2 (Phase 6): one memory row per (project, namespace, key).
	agentMemoryProjectKey: "agent_memory_project_key_idx",
} as const;
