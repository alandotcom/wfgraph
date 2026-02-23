import { cp, stat } from "node:fs/promises";
import { resolve } from "node:path";

const src = resolve(import.meta.dir, "../../drizzle");
const dest = resolve(import.meta.dir, "../../dist/drizzle");

try {
  await stat(src);
  await cp(src, dest, { recursive: true });
  console.log("Copied drizzle/ → dist/drizzle/");
} catch (error: unknown) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    console.warn("drizzle/ not found, skipping migration copy");
  } else {
    throw error;
  }
}
