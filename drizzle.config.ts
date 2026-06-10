/**
 * drizzle-kit config. Migrations are GENERATED (`bun run db:generate`) and
 * applied programmatically via `src/db/migrate.ts` — never `drizzle-kit push`
 * (push diffs against a live DB and can drop data; generated SQL is reviewed
 * and committed instead).
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./src/db/schema.ts",
	out: "./drizzle",
});
