import { config } from "dotenv";
import type { Config } from "drizzle-kit";

config();

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
