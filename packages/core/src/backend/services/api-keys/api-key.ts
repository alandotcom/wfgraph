import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailure } from "#src/backend/lib/effect/internal-failure";
import { NotFound } from "#src/backend/lib/effect/failures";
import { ApiKeyRepo } from "./repo";

/** The contract answers a delete with this and nothing else. */
type ApiKeyDeleted = { success: true };

export const deleteApiKey = Effect.fn("deleteApiKey")(function* (
  keyId: string
) {
  const repo = yield* ApiKeyRepo;
  const logger = (yield* AppLogger).get("api-keys").with({ keyId });

  const deletedIds = yield* repo
    .deleteById(keyId)
    .pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailure(logger, "Failed to delete API key")
      )
    );

  if (deletedIds.length === 0) {
    yield* logger.warn("API key not found for delete");
    return yield* Effect.fail(new NotFound({ error: "API key not found" }));
  }

  const deleted: ApiKeyDeleted = { success: true };
  return deleted;
});
