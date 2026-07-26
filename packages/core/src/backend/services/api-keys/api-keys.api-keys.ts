import { db } from "@/backend/lib/db";
import { apiKeys } from "@/backend/lib/db/schema";
import { getAppLogger } from "@/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "@/backend/lib/service-result";
import { getErrorMessage } from "@/shared/utils";
import { createApiKeyRecord } from "./auth.api-keys";

const apiKeysLogger = getAppLogger("api-keys");

type ApiKeyListItem = {
  id: string;
  name: string | null;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
};

type ApiKeyCreated = {
  id: string;
  name: string | null;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  key: string;
};

type ApiKeyError = { error: string };

export async function getApiKeysResult(): Promise<
  ServiceResult<ApiKeyListItem[], 500, ApiKeyError>
> {
  try {
    const keys = await db.query.apiKeys.findMany({
      columns: {
        id: true,
        name: true,
        keyPrefix: true,
        createdAt: true,
        lastUsedAt: true,
      },
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    });

    return success(
      keys.map((key) => ({
        id: key.id,
        name: key.name,
        keyPrefix: key.keyPrefix,
        createdAt: key.createdAt.toISOString(),
        lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
      }))
    );
  } catch (error) {
    apiKeysLogger.error(`Failed to list API keys: ${getErrorMessage(error)}`, {
      error,
    });
    return failure(500, { error: "Failed to list API keys" });
  }
}

export async function postApiKeysResult(body: {
  name?: string;
}): Promise<ServiceResult<ApiKeyCreated, 500, ApiKeyError>> {
  try {
    const name = body.name || null;

    const { key, keyHash, keyPrefix } = await createApiKeyRecord();

    const [newKey] = await db
      .insert(apiKeys)
      .values({
        name,
        keyHash,
        keyPrefix,
      })
      .returning({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        createdAt: apiKeys.createdAt,
      });

    return success({
      id: newKey.id,
      name: newKey.name,
      keyPrefix: newKey.keyPrefix,
      createdAt: newKey.createdAt.toISOString(),
      lastUsedAt: null,
      key,
    });
  } catch (error) {
    apiKeysLogger.error(`Failed to create API key: ${getErrorMessage(error)}`, {
      error,
    });
    return failure(500, { error: "Failed to create API key" });
  }
}
