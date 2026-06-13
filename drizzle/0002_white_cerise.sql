CREATE TABLE `agent_memory` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`namespace` text DEFAULT 'note' NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_memory_project_key_idx` ON `agent_memory` (`project_id`,`namespace`,`key`);