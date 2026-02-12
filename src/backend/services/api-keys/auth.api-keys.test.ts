import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const findMany = vi.fn();
  const where = vi.fn(() => Promise.resolve([]));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    with: vi.fn(),
  };

  logger.with.mockReturnValue(logger);

  return {
    findMany,
    where,
    set,
    update,
    logger,
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apiKeys: {
        findMany: mocks.findMany,
      },
    },
    update: mocks.update,
  },
}));

vi.mock("@/lib/logger", () => ({
  getAppLogger: () => mocks.logger,
}));

import {
  createApiKeyRecord,
  validateApiKey,
} from "@/backend/services/api-keys/auth.api-keys";

type BunPasswordApi = {
  hash: (value: string) => Promise<string>;
  verify: (value: string, hash: string) => Promise<boolean>;
};

type BunApi = {
  password: BunPasswordApi;
};

function installBunPasswordMock() {
  const runtime = globalThis as { Bun?: BunApi };
  runtime.Bun = {
    password: {
      hash: async (value: string) => `hash:${value}`,
      verify: async (value: string, hash: string) => hash === `hash:${value}`,
    },
  };
}

describe("api key auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installBunPasswordMock();
    mocks.logger.with.mockReturnValue(mocks.logger);
  });

  it("creates a prefixed API key with Bun password hash", async () => {
    const record = await createApiKeyRecord();

    expect(record.key.startsWith("wfb_")).toBe(true);
    expect(record.keyPrefix).toBe(record.key.slice(0, 11));
    expect(record.keyHash).toBe(`hash:${record.key}`);
  });

  it("verifies API key candidates and updates lastUsedAt on success", async () => {
    const key = "wfb_valid_key";
    mocks.findMany.mockResolvedValueOnce([
      { id: "k1", keyHash: "hash:wfb_other_key" },
      { id: "k2", keyHash: `hash:${key}` },
    ]);

    const result = await validateApiKey(`Bearer ${key}`);

    expect(result).toEqual({ valid: true, keyId: "k2" });
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith({ lastUsedAt: expect.any(Date) });
    expect(mocks.where).toHaveBeenCalledTimes(1);
  });

  it("rejects requests without auth header", async () => {
    const result = await validateApiKey(null);

    expect(result).toEqual({
      valid: false,
      error: "Missing Authorization header",
      statusCode: 401,
    });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("rejects invalid keys", async () => {
    mocks.findMany.mockResolvedValueOnce([{ id: "k1", keyHash: "hash:wfb_x" }]);

    const result = await validateApiKey("Bearer wfb_not_found");

    expect(result).toEqual({
      valid: false,
      error: "Invalid API key",
      statusCode: 401,
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
