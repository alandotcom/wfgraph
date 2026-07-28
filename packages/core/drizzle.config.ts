// First, so DATABASE_URL below is read after .env has been applied. The repo's
// one loader, rather than a dotenv call of this file's own, so .env.local keeps
// winning over .env here too. drizzle-kit bundles this config with esbuild, so
// the relative TypeScript import resolves; the .env paths inside it are relative
// to the working directory, and every db:* script runs from the repo root.
import "../../load-env";
import type { Config } from "drizzle-kit";

export default {
  schema: "./packages/core/src/backend/lib/db/schema.ts",
  out: "./packages/core/drizzle",
  dialect: "postgresql",
  schemaFilter: ["_workflows"],
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      "postgresql://workflow:workflow@localhost:55437/workflow_builder",
  },
} satisfies Config;
