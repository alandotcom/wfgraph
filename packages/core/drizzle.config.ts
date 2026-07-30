import type { Config } from "drizzle-kit";

/**
 * Generation only, with no database credentials at all.
 *
 * Rova's tables are declared unqualified and the schema they live in comes from
 * the running app's `database.schema`, so drizzle-kit cannot be told where they
 * are: `push` offers to drop whichever schema it was filtered onto, and `studio`
 * and `pull` look in `public` and find nothing. Generating SQL is the one thing
 * it does without a connection. `pnpm run db:migrate` applies that SQL through
 * Rova's own migrator, which is what carries the search_path.
 *
 * `pnpm run db:generate` runs a second step after this one: drizzle-kit
 * qualifies a foreign key's target with `public` even where both tables are
 * unqualified, and scripts/unqualify-migrations.ts takes that qualifier off
 * again.
 */
export default {
  schema: "./packages/core/src/backend/lib/db/schema.ts",
  out: "./packages/core/drizzle",
  dialect: "postgresql",
} satisfies Config;
