import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./packages/core/src/backend/persistence/sqlite/schema.ts",
  out: "./packages/core/drizzle-sqlite",
  dialect: "sqlite",
});
