import { db } from "@/lib/db";
import { apiKeys } from "@/lib/db/schema";
import { getAppLogger } from "@/lib/logger";
import { createApiKeyRecord } from "./auth.api-keys";

const apiKeysLogger = getAppLogger("api-keys");

export async function getApiKeys() {
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

    return Response.json(keys);
  } catch (error) {
    apiKeysLogger.error("Failed to list API keys", { error });
    return Response.json({ error: "Failed to list API keys" }, { status: 500 });
  }
}

export async function postApiKeys(body: { name?: string }) {
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

    return Response.json({
      ...newKey,
      key,
    });
  } catch (error) {
    apiKeysLogger.error("Failed to create API key", { error });
    return Response.json(
      { error: "Failed to create API key" },
      { status: 500 }
    );
  }
}
