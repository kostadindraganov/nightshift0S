/**
 * Programmatic migrator. Called at server startup and from tests so a fresh
 * database (file or :memory:) is brought to the current schema before any
 * query runs. Migrations are the generated SQL files in `drizzle/` — see
 * drizzle.config.ts for why push is never used.
 *
 * Also runnable directly: `bun run db:migrate`.
 */

import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "node:path";
import { openDatabase, type DbHandle } from "./client.ts";

const MIGRATIONS_FOLDER = join(import.meta.dir, "../../drizzle");

export function runMigrations(handle: DbHandle): void {
	migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
}

if (import.meta.main) {
	const handle = openDatabase();
	runMigrations(handle);
	console.log(`migrated ${handle.path}`);
	handle.sqlite.close();
}
