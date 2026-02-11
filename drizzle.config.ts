import { config } from "dotenv";
import type { Config } from "drizzle-kit";

config();

export default {
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgres://localhost:55437/workflow",
  },
} satisfies Config;
