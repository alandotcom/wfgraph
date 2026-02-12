import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { apiKeys } from "@/backend/lib/db/schema";
import { getAppLogger } from "@/backend/lib/logger";

const apiKeyLogger = getAppLogger("api-keys");

export async function deleteApiKey(keyId: string) {
  const requestLogger = apiKeyLogger.with({ keyId });
  try {
    const result = await db
      .delete(apiKeys)
      .where(eq(apiKeys.id, keyId))
      .returning({ id: apiKeys.id });

    if (result.length === 0) {
      requestLogger.warn("API key not found for delete");
      return Response.json({ error: "API key not found" }, { status: 404 });
    }

    return Response.json({ success: true });
  } catch (error) {
    requestLogger.error("Failed to delete API key", { error });
    return Response.json(
      { error: "Failed to delete API key" },
      { status: 500 }
    );
  }
}
