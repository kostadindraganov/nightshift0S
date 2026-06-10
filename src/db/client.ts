/**
 * Database connection factory (SPEC-SCHEMA "SQLite discipline" §3.12.11).
 *
 * One `bun:sqlite` connection per process, wrapped with drizzle. Pragmas are
 * applied on open, in spec order: WAL for concurrent readers alongside the
 * single writer, busy_timeout as a backstop under the retry loop in
 * `writer.ts`, foreign_keys ON (off by default in SQLite), and
 * synchronous=NORMAL (safe with WAL; fsync on checkpoint, not per-commit).
 *
 * Path resolution: `NIGHTSHIFT_DB_PATH` env var, default `data/nightshift.db`.
 * `:memory:` is supported for tests. The parent directory is created for
 * file-backed paths so first boot doesn't need a manual `mkdir data`.
 */

import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema.ts";

export type NightshiftDb = BunSQLiteDatabase<typeof schema>;

export interface DbHandle {
	/** Raw bun:sqlite handle — pragmas, checkpoints, close(). */
	sqlite: Database;
	/** Drizzle wrapper — all query building goes through this. */
	db: NightshiftDb;
	/** Resolved database file path (or ":memory:"). */
	path: string;
}

export const DEFAULT_DB_PATH = "data/nightshift.db";

/** WAL size threshold above which `maybeCheckpoint` truncates: 64 MB. */
const WAL_CHECKPOINT_BYTES = 64 * 1024 * 1024;

export function openDatabase(path?: string): DbHandle {
	const resolved = path ?? process.env.NIGHTSHIFT_DB_PATH ?? DEFAULT_DB_PATH;
	if (resolved !== ":memory:") {
		const dir = dirname(resolved);
		if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
	}
	const sqlite = new Database(resolved, { create: true });
	// Spec order (§3.12.11). WAL is a no-op for :memory: (reports "memory").
	sqlite.run("PRAGMA journal_mode=WAL;");
	sqlite.run("PRAGMA busy_timeout=5000;");
	sqlite.run("PRAGMA foreign_keys=ON;");
	sqlite.run("PRAGMA synchronous=NORMAL;");
	const db = drizzle(sqlite, { schema });
	return { sqlite, db, path: resolved };
}

/**
 * Truncate the WAL when it has grown past 64 MB (§3.12.11). Called from an
 * idle tick (wired in a later phase — no timer lives here). Passive
 * checkpointing normally keeps the WAL small; this is the backstop for
 * long-lived readers pinning the WAL.
 */
export function maybeCheckpoint(handle: DbHandle): void {
	if (handle.path === ":memory:") return;
	const walPath = `${handle.path}-wal`;
	if (!existsSync(walPath)) return;
	if (statSync(walPath).size <= WAL_CHECKPOINT_BYTES) return;
	handle.sqlite.run("PRAGMA wal_checkpoint(TRUNCATE);");
}
