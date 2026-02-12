import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { apiKeys } from "@/backend/lib/db/schema";
import { getAppLogger } from "@/backend/lib/logger";

const API_KEY_PREFIX = "wfb_";
const API_KEY_PREFIX_LENGTH = 11;
const apiKeyAuthLogger = getAppLogger("api-keys", "auth");

type ApiKeyValidationResult =
  | { valid: true; keyId: string }
  | { valid: false; error: string; statusCode: number };

function parseApiKeyFromAuthHeader(authHeader: string | null): {
  key?: string;
  error?: string;
  statusCode?: number;
} {
  if (!authHeader) {
    return {
      error: "Missing Authorization header",
      statusCode: 401,
    };
  }

  const key = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  if (!key?.startsWith(API_KEY_PREFIX)) {
    return {
      error: "Invalid API key format",
      statusCode: 401,
    };
  }

  return { key };
}

export async function createApiKeyRecord(): Promise<{
  key: string;
  keyHash: string;
  keyPrefix: string;
}> {
  const randomPart = randomBytes(24).toString("base64url");
  const key = `${API_KEY_PREFIX}${randomPart}`;
  const keyHash = await Bun.password.hash(key);
  const keyPrefix = key.slice(0, API_KEY_PREFIX_LENGTH);

  return { key, keyHash, keyPrefix };
}

export async function validateApiKey(
  authHeader: string | null
): Promise<ApiKeyValidationResult> {
  const parsed = parseApiKeyFromAuthHeader(authHeader);
  if (!parsed.key) {
    return {
      valid: false,
      error: parsed.error ?? "Invalid API key",
      statusCode: parsed.statusCode ?? 401,
    };
  }

  const keyPrefix = parsed.key.slice(0, API_KEY_PREFIX_LENGTH);
  const candidates = await db.query.apiKeys.findMany({
    where: eq(apiKeys.keyPrefix, keyPrefix),
    columns: {
      id: true,
      keyHash: true,
    },
  });

  for (const candidate of candidates) {
    try {
      const isMatch = await Bun.password.verify(parsed.key, candidate.keyHash);
      if (!isMatch) {
        continue;
      }

      db.update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, candidate.id))
        .catch((error: unknown) => {
          apiKeyAuthLogger.warn(
            "Failed to update API key last-used timestamp",
            {
              keyId: candidate.id,
              error,
            }
          );
        });

      return { valid: true, keyId: candidate.id };
    } catch (error) {
      apiKeyAuthLogger.warn("Failed to verify API key candidate hash", {
        keyId: candidate.id,
        error,
      });
    }
  }

  return {
    valid: false,
    error: "Invalid API key",
    statusCode: 401,
  };
}
