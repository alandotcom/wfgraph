import { config } from "dotenv";
import type { Config } from "drizzle-kit";

config();

export default {
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      Bun.env.DATABASE_URL ||
      "postgresql://workflow:workflow@localhost:55437/workflow_builder",
  },
} satisfies Config;
