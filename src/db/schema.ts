/**
 * SQLite physical schema for nightshift's durable state (docs/SPEC-SCHEMA.md
 * v1.0, BLUEPRINT §3.12.10/.11/.20).
 *
 * Thirteen tables: projects, tasks (+ task_dependencies), runs, thread_events
 * (the append-only task conversation), findings (anchored review findings),
 * events (global event log), providers, prompts, routines, triggers,
 * experiment_ledger, settings.
 *
 * Conventions (warren R-13 pattern — see `reference/warren/db/sqlite.ts`):
 *   - Integer autoincrement PKs (SPEC-SCHEMA `int pk`).
 *   - Timestamps are ISO8601 TEXT.
 *   - Enum columns use drizzle `{ enum: ... }` tuples from `./columns.ts` —
 *     TS-only narrowing, no SQL CHECK. State-machine guards live in app code.
 *   - JSON columns are plain TEXT named `*_json`; (de)serialization happens at
 *     the repo layer so redaction (§3.12.28) can run before persist.
 *
 * The one schema-level state-machine invariant lives here: the partial unique
 * index `one_active_run_per_task` on runs(task_id) WHERE state NOT IN the
 * terminal set, which makes "at most one active run per task" a DB guarantee
 * rather than an application promise.
 */

import { sql } from "drizzle-orm";
import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
	type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import {
	AUTH_LANES,
	CIRCUIT_STATES,
	EXPERIMENT_STATUSES,
	FINDING_RESOLUTION_STATES,
	FINDING_SEVERITIES,
	INDEX_NAMES,
	PROVIDER_AUTH_MODES,
	PROVIDER_KINDS,
	REVIEW_POLICIES,
	RISK_TIERS,
	ROUTINE_KINDS,
	RUN_KINDS,
	RUN_STATES,
	SETTING_SCOPES,
	TABLE_NAMES,
	TASK_CATEGORIES,
	TASK_STATES,
	THREAD_EVENT_KINDS,
	TRIGGER_KINDS,
} from "./columns.ts";

export const projects = sqliteTable(TABLE_NAMES.projects, {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
	repoUrl: text("repo_url").notNull(),
	defaultBranch: text("default_branch").notNull().default("main"),
	// Per-project overrides. V1: file-sourced, mirrored here read-only.
	settingsJson: text("settings_json"),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
});

/**
 * Routines reference projects (nullable — a routine can be global) and are
 * referenced by tasks/triggers for provenance, so they sit before tasks here.
 * Definition: SPEC-SCHEMA §routines.
 */
export const routines = sqliteTable(TABLE_NAMES.routines, {
	id: integer("id").primaryKey({ autoIncrement: true }),
	projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	kind: text("kind", { enum: ROUTINE_KINDS }).notNull(),
	promptName: text("prompt_name").notNull(),
	paramsJson: text("params_json"),
	providerPref: text("provider_pref"),
	rubric: text("rubric"),
	// Wall-clock budget (enforced) + advisory token budget.
	budgetJson: text("budget_json"),
	reviewPolicy: text("review_policy", { enum: REVIEW_POLICIES }).notNull().default("full"),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

export const tasks = sqliteTable(
	TABLE_NAMES.tasks,
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		projectId: integer("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		description: text("description"),
		// Testable assertions (§3.5).
		acceptanceCriteria: text("acceptance_criteria"),
		state: text("state", { enum: TASK_STATES }).notNull().default("draft"),
		// localforge demotion semantics: failed tasks get bumped past current max.
		priority: integer("priority").notNull().default(0),
		category: text("category", { enum: TASK_CATEGORIES }).notNull().default("functional"),
		riskTier: text("risk_tier", { enum: RISK_TIERS }).notNull().default("full"),
		// `ns/<task_id>-<slug>`.
		branch: text("branch"),
		// Merge-base recorded at claim (§3.12.12/.29).
		baseSha: text("base_sha"),
		// Set ⟺ done. Dependency readiness checks key off this being non-null.
		mergeSha: text("merge_sha"),
		// Active claim. SET NULL (not cascade): a deleted run row releases the
		// claim instead of taking the task with it.
		claimedBy: integer("claimed_by").references((): AnySQLiteColumn => runs.id, {
			onDelete: "set null",
		}),
		// Current review round.
		round: integer("round").notNull().default(0),
		// Provenance: which routine spawned this task. SET NULL so deleting a
		// routine keeps its task history.
		routineId: integer("routine_id").references(() => routines.id, { onDelete: "set null" }),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [
		index(INDEX_NAMES.tasksProjectState).on(t.projectId, t.state),
		index(INDEX_NAMES.tasksProjectPriority).on(t.projectId, t.priority),
	],
);

/**
 * Dependency edges. Cycle check (BFS) happens at insert in app code
 * (localforge pattern); readiness = all deps' merge_sha NOT NULL.
 */
export const taskDependencies = sqliteTable(
	TABLE_NAMES.taskDependencies,
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		taskId: integer("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		dependsOnTaskId: integer("depends_on_task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
	},
	(t) => [uniqueIndex(INDEX_NAMES.taskDependenciesUnique).on(t.taskId, t.dependsOnTaskId)],
);

export const runs = sqliteTable(
	TABLE_NAMES.runs,
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		// Null for utility/experiment routine runs. SET NULL (not cascade) so
		// run history (cost telemetry) survives task deletion.
		taskId: integer("task_id").references(() => tasks.id, { onDelete: "set null" }),
		kind: text("kind", { enum: RUN_KINDS }).notNull(),
		// Resolved at spawn.
		provider: text("provider").notNull(),
		model: text("model").notNull(),
		authLane: text("auth_lane", { enum: AUTH_LANES }).notNull(),
		state: text("state", { enum: RUN_STATES }).notNull().default("queued"),
		// Provider session id (resume across rounds, per-task HOME §3.12.24).
		sessionId: text("session_id"),
		worktreePath: text("worktree_path"),
		tmuxSession: text("tmux_session"),
		homePath: text("home_path"),
		// Commit the run produced/reviewed.
		headSha: text("head_sha"),
		// Classified exit reason (auto-triage input).
		exitReason: text("exit_reason"),
		tokensIn: integer("tokens_in"),
		tokensOut: integer("tokens_out"),
		costUsd: real("cost_usd"),
		// Cost telemetry proven (§3.12.15).
		priced: integer("priced", { mode: "boolean" }).notNull().default(false),
		// Wall-clock budget enforcement keys off these. Nullable: a queued run
		// hasn't started; a live run hasn't ended.
		startedAt: text("started_at"),
		endedAt: text("ended_at"),
	},
	(t) => [
		index(INDEX_NAMES.runsTaskState).on(t.taskId, t.state),
		// THE schema-level invariant: at most one non-terminal run per task.
		// Must stay in sync with RUN_TERMINAL_STATES in columns.ts.
		uniqueIndex(INDEX_NAMES.oneActiveRunPerTask)
			.on(t.taskId)
			.where(sql`state NOT IN ('succeeded', 'failed', 'killed', 'interrupted')`),
	],
);

/**
 * Append-only task conversation (§3.12.10). No UPDATE/DELETE except redaction
 * (`payload_json` overwrite + `redacted=1`) and retention pruning — enforced
 * at the repo layer, not in SQL.
 */
export const threadEvents = sqliteTable(
	TABLE_NAMES.threadEvents,
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		taskId: integer("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		// Monotonic per task.
		seq: integer("seq").notNull(),
		kind: text("kind", { enum: THREAD_EVENT_KINDS }).notNull(),
		// e.g. `coder:claude-code`, `reviewer:codex`, `human:<user>`, `system`.
		actor: text("actor").notNull(),
		round: integer("round").notNull().default(0),
		runId: integer("run_id").references(() => runs.id, { onDelete: "set null" }),
		// Dedupes hook/retry double-delivery. Nullable unique: SQLite treats
		// NULLs as distinct, so rows without a key never collide.
		idempotencyKey: text("idempotency_key"),
		// Redacted before persist (§3.12.28).
		payloadJson: text("payload_json").notNull(),
		// JSON list of artifact paths/ids (files live under data/artifacts/).
		artifactRefs: text("artifact_refs"),
		redacted: integer("redacted", { mode: "boolean" }).notNull().default(false),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		uniqueIndex(INDEX_NAMES.threadEventsTaskSeq).on(t.taskId, t.seq),
		uniqueIndex(INDEX_NAMES.threadEventsIdempotencyKey).on(t.idempotencyKey),
	],
);

/** Anchored review findings (§3.12.10). */
export const findings = sqliteTable(TABLE_NAMES.findings, {
	id: integer("id").primaryKey({ autoIncrement: true }),
	taskId: integer("task_id")
		.notNull()
		.references(() => tasks.id, { onDelete: "cascade" }),
	// Round the finding was introduced in.
	round: integer("round").notNull(),
	runId: integer("run_id").references(() => runs.id, { onDelete: "set null" }),
	severity: text("severity", { enum: FINDING_SEVERITIES }).notNull(),
	// 0..1.
	confidence: real("confidence").notNull(),
	// Head SHA reviewed.
	commitSha: text("commit_sha").notNull(),
	// Old/new paths survive renames; nullable for non-file-anchored findings.
	filePathOld: text("file_path_old"),
	filePathNew: text("file_path_new"),
	// Patch context anchor (survives line drift).
	hunkContext: text("hunk_context"),
	description: text("description").notNull(),
	suggestion: text("suggestion"),
	resolutionState: text("resolution_state", { enum: FINDING_RESOLUTION_STATES })
		.notNull()
		.default("open"),
	resolvedRound: integer("resolved_round"),
});

/**
 * Global event log (warren pattern). Write-through before broker publish;
 * the in-memory broker is bounded (1024, drop-oldest + dropped counter).
 * Streaming: subscribe → replay history → tail, dedup by seq.
 */
export const events = sqliteTable(
	TABLE_NAMES.events,
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
		runId: integer("run_id").references(() => runs.id, { onDelete: "set null" }),
		taskId: integer("task_id").references(() => tasks.id, { onDelete: "set null" }),
		seq: integer("seq").notNull(),
		kind: text("kind").notNull(),
		payloadJson: text("payload_json").notNull(),
		ts: text("ts").notNull(),
	},
	(t) => [index(INDEX_NAMES.eventsSeq).on(t.seq), index(INDEX_NAMES.eventsTask).on(t.taskId)],
);

export const providers = sqliteTable(TABLE_NAMES.providers, {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
	kind: text("kind", { enum: PROVIDER_KINDS }).notNull(),
	authMode: text("auth_mode", { enum: PROVIDER_AUTH_MODES }).notNull(),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
	// Written ONLY by conformance test runs (§3.12.13).
	capabilitiesJson: text("capabilities_json"),
	// Capacity-pool state (§3.12.14).
	concurrencyCap: integer("concurrency_cap").notNull().default(1),
	cooldownUntil: text("cooldown_until"),
	circuitState: text("circuit_state", { enum: CIRCUIT_STATES }).notNull().default("closed"),
	lastError: text("last_error"),
});

/** Versioned org code (§3.8). Active version pinned per routine/role. */
export const prompts = sqliteTable(
	TABLE_NAMES.prompts,
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		name: text("name").notNull(),
		version: integer("version").notNull(),
		body: text("body").notNull(),
		createdBy: text("created_by").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(t) => [uniqueIndex(INDEX_NAMES.promptsNameVersion).on(t.name, t.version)],
);

export const triggers = sqliteTable(TABLE_NAMES.triggers, {
	id: integer("id").primaryKey({ autoIncrement: true }),
	routineId: integer("routine_id")
		.notNull()
		.references(() => routines.id, { onDelete: "cascade" }),
	kind: text("kind", { enum: TRIGGER_KINDS }).notNull(),
	// Cron expression; null for manual/webhook/chat triggers.
	schedule: text("schedule"),
	// Allowlist / rate-limit / dedupe config (§3.12.6).
	authzJson: text("authz_json"),
	dryRunDefault: integer("dry_run_default", { mode: "boolean" }).notNull().default(false),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
	// Fire history goes to the events table; this is just the latest stamp.
	lastFiredAt: text("last_fired_at"),
});

/** Experiment iteration ledger (§3.11). Renders as timeline + metric chart. */
export const experimentLedger = sqliteTable(TABLE_NAMES.experimentLedger, {
	id: integer("id").primaryKey({ autoIncrement: true }),
	routineRunId: integer("routine_run_id")
		.notNull()
		.references(() => runs.id, { onDelete: "cascade" }),
	iteration: integer("iteration").notNull(),
	// Nullable: a `crash` iteration may never have committed.
	commitSha: text("commit_sha"),
	metricName: text("metric_name").notNull(),
	metricValue: real("metric_value"),
	status: text("status", { enum: EXPERIMENT_STATUSES }).notNull(),
	memoryNote: text("memory_note"),
	description: text("description").notNull(),
	createdAt: text("created_at").notNull(),
});

/**
 * V1: read-only mirror of the config file; V1.5: editable registry.
 * Secrets are NOT here — they live in the OS keyring/sealed store (§3.12.7);
 * this table stores references only.
 */
export const settings = sqliteTable(
	TABLE_NAMES.settings,
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		scope: text("scope", { enum: SETTING_SCOPES }).notNull(),
		// Project/routine id for scoped rows; null for global scope. NOTE:
		// SQLite NULL-distinct semantics mean the composite unique below does
		// not dedupe two global rows with the same key — the settings mirror
		// writer must use scope_id = 0 sentinel or upsert-by-select for globals.
		scopeId: integer("scope_id"),
		key: text("key").notNull(),
		valueJson: text("value_json").notNull(),
		updatedBy: text("updated_by").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [uniqueIndex(INDEX_NAMES.settingsScopeKey).on(t.scope, t.scopeId, t.key)],
);

/**
 * V2 (Phase 6): per-project agent memory — accumulated learnings the factory
 * carries across runs (e.g. "this repo's tests need NODE_ENV=test"). Key-value
 * within a namespace, upserted per (project, namespace, key). Code/output may be
 * referenced; secret values must NOT be stored here (§3.12.7) — references only,
 * same rule as `settings`.
 */
export const agentMemory = sqliteTable(
	TABLE_NAMES.agentMemory,
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		projectId: integer("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		// Grouping bucket (e.g. "lessons", "conventions", "facts"). Default "note".
		namespace: text("namespace").notNull().default("note"),
		key: text("key").notNull(),
		valueJson: text("value_json").notNull(),
		// Provenance: `agent:<provider>`, `run:<id>`, `human:<user>`, `system`.
		source: text("source").notNull(),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [uniqueIndex(INDEX_NAMES.agentMemoryProjectKey).on(t.projectId, t.namespace, t.key)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskInsert = typeof tasks.$inferInsert;
export type TaskDependencyRow = typeof taskDependencies.$inferSelect;
export type TaskDependencyInsert = typeof taskDependencies.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type RunInsert = typeof runs.$inferInsert;
export type ThreadEventRow = typeof threadEvents.$inferSelect;
export type ThreadEventInsert = typeof threadEvents.$inferInsert;
export type FindingRow = typeof findings.$inferSelect;
export type FindingInsert = typeof findings.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type EventInsert = typeof events.$inferInsert;
export type ProviderRow = typeof providers.$inferSelect;
export type ProviderInsert = typeof providers.$inferInsert;
export type PromptRow = typeof prompts.$inferSelect;
export type PromptInsert = typeof prompts.$inferInsert;
export type RoutineRow = typeof routines.$inferSelect;
export type RoutineInsert = typeof routines.$inferInsert;
export type TriggerRow = typeof triggers.$inferSelect;
export type TriggerInsert = typeof triggers.$inferInsert;
export type ExperimentLedgerRow = typeof experimentLedger.$inferSelect;
export type ExperimentLedgerInsert = typeof experimentLedger.$inferInsert;
export type SettingRow = typeof settings.$inferSelect;
export type SettingInsert = typeof settings.$inferInsert;
export type AgentMemoryRow = typeof agentMemory.$inferSelect;
export type AgentMemoryInsert = typeof agentMemory.$inferInsert;
