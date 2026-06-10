CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer,
	`run_id` integer,
	`task_id` integer,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`ts` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `events_seq_idx` ON `events` (`seq`);--> statement-breakpoint
CREATE INDEX `events_task_idx` ON `events` (`task_id`);--> statement-breakpoint
CREATE TABLE `experiment_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`routine_run_id` integer NOT NULL,
	`iteration` integer NOT NULL,
	`commit_sha` text,
	`metric_name` text NOT NULL,
	`metric_value` real,
	`status` text NOT NULL,
	`memory_note` text,
	`description` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`routine_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`round` integer NOT NULL,
	`run_id` integer,
	`severity` text NOT NULL,
	`confidence` real NOT NULL,
	`commit_sha` text NOT NULL,
	`file_path_old` text,
	`file_path_new` text,
	`hunk_context` text,
	`description` text NOT NULL,
	`suggestion` text,
	`resolution_state` text DEFAULT 'open' NOT NULL,
	`resolved_round` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`repo_url` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`settings_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prompts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_name_version_idx` ON `prompts` (`name`,`version`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`auth_mode` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`capabilities_json` text,
	`concurrency_cap` integer DEFAULT 1 NOT NULL,
	`cooldown_until` text,
	`circuit_state` text DEFAULT 'closed' NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `routines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`prompt_name` text NOT NULL,
	`params_json` text,
	`provider_pref` text,
	`rubric` text,
	`budget_json` text,
	`review_policy` text DEFAULT 'full' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`auth_lane` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`session_id` text,
	`worktree_path` text,
	`tmux_session` text,
	`home_path` text,
	`head_sha` text,
	`exit_reason` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`cost_usd` real,
	`priced` integer DEFAULT false NOT NULL,
	`started_at` text,
	`ended_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `runs_task_state_idx` ON `runs` (`task_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_active_run_per_task` ON `runs` (`task_id`) WHERE state NOT IN ('succeeded', 'failed', 'killed', 'interrupted');--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`scope_id` integer,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settings_scope_key_idx` ON `settings` (`scope`,`scope_id`,`key`);--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`depends_on_task_id` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_dependencies_unique_idx` ON `task_dependencies` (`task_id`,`depends_on_task_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`acceptance_criteria` text,
	`state` text DEFAULT 'draft' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`category` text DEFAULT 'functional' NOT NULL,
	`risk_tier` text DEFAULT 'full' NOT NULL,
	`branch` text,
	`base_sha` text,
	`merge_sha` text,
	`claimed_by` integer,
	`round` integer DEFAULT 0 NOT NULL,
	`routine_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`claimed_by`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tasks_project_state_idx` ON `tasks` (`project_id`,`state`);--> statement-breakpoint
CREATE INDEX `tasks_project_priority_idx` ON `tasks` (`project_id`,`priority`);--> statement-breakpoint
CREATE TABLE `thread_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`round` integer DEFAULT 0 NOT NULL,
	`run_id` integer,
	`idempotency_key` text,
	`payload_json` text NOT NULL,
	`artifact_refs` text,
	`redacted` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_events_task_seq_idx` ON `thread_events` (`task_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `thread_events_idempotency_key_idx` ON `thread_events` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `triggers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`routine_id` integer NOT NULL,
	`kind` text NOT NULL,
	`schedule` text,
	`authz_json` text,
	`dry_run_default` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_fired_at` text,
	FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON UPDATE no action ON DELETE cascade
);
