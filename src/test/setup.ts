import { env as nodeEnv } from "node:process";

const globalWithBun = globalThis as typeof globalThis & {
  Bun?: unknown;
};

if (!globalWithBun.Bun) {
  (globalWithBun as Record<string, unknown>).Bun = {
    env: nodeEnv as Record<string, string | undefined>,
  };
}
