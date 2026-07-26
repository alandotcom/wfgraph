import { beforeEach, describe, expect, it, mock, vi } from "bun:test";

const mocks = (() => {
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
})();

mock.module("@/backend/lib/db", () => ({
  db: {
    query: {
      apiKeys: {
        findMany: mocks.findMany,
      },
    },
    update: mocks.update,
  },
}));

mock.module("@/backend/lib/logger", () => ({
  getAppLogger: () => mocks.logger,
}));

mock.module("bcryptjs", () => ({
  hash: async (value: string) => `hash:${value}`,
  compare: async (value: string, hashed: string) => hashed === `hash:${value}`,
}));

const { createApiKeyRecord, validateApiKey } = await import(
  "@/backend/services/api-keys/auth.api-keys"
);

describe("api key auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.logger.with.mockReturnValue(mocks.logger);
  });

  it("creates a prefixed API key with bcrypt hash", async () => {
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
    });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("rejects invalid keys", async () => {
    mocks.findMany.mockResolvedValueOnce([{ id: "k1", keyHash: "hash:wfb_x" }]);

    const result = await validateApiKey("Bearer wfb_not_found");

    expect(result).toEqual({ valid: false, error: "Invalid API key" });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
