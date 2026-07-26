import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { apiKeys } from "@/backend/lib/db/schema";
import { getAppLogger } from "@/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "@/backend/lib/service-result";
import { getErrorMessage } from "@/shared/utils";

const apiKeyLogger = getAppLogger("api-keys");

type DeleteApiKeyError = { error: string };

export async function deleteApiKeyResult(
  keyId: string
): Promise<
  ServiceResult<{ success: true }, "not_found" | "internal", DeleteApiKeyError>
> {
  const requestLogger = apiKeyLogger.with({ keyId });
  try {
    const result = await db
      .delete(apiKeys)
      .where(eq(apiKeys.id, keyId))
      .returning({ id: apiKeys.id });

    if (result.length === 0) {
      requestLogger.warn("API key not found for delete");
      return failure("not_found", { error: "API key not found" });
    }

    return success({ success: true });
  } catch (error) {
    requestLogger.error(`Failed to delete API key: ${getErrorMessage(error)}`, {
      error,
    });
    return failure("internal", { error: "Failed to delete API key" });
  }
}
