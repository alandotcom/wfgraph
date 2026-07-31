import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailure } from "#src/backend/lib/effect/internal-failure";
import { createApiKeyRecord } from "#src/backend/services/api-keys/auth";
import {
  type ApiKeySummary,
  ApiKeyRepo,
} from "#src/backend/services/api-keys/repo";

type ApiKeyListItem = {
  id: string;
  name: string | null;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
};

type ApiKeyCreated = ApiKeyListItem & {
  key: string;
};

/** Timestamps cross the wire as ISO strings, which is what the contract states. */
function toListItem(key: ApiKeySummary): ApiKeyListItem {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
  };
}

export const getApiKeys = Effect.fn("getApiKeys")(function* () {
  const repo = yield* ApiKeyRepo;
  const logger = (yield* AppLogger).get("api-keys");

  const keys = yield* repo.listNewestFirst.pipe(
    Effect.catchTag(
      "DatabaseError",
      internalFailure(logger, "Failed to list API keys")
    )
  );

  return keys.map(toListItem);
});

export const postApiKeys = Effect.fn("postApiKeys")(function* (body: {
  name?: string;
}) {
  const repo = yield* ApiKeyRepo;
  const logger = (yield* AppLogger).get("api-keys");

  const { key, keyHash, keyPrefix } = yield* createApiKeyRecord();

  const created = yield* repo
    .insert({ name: body.name || null, keyHash, keyPrefix })
    .pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailure(logger, "Failed to create API key")
      )
    );

  const apiKey: ApiKeyCreated = { ...toListItem(created), key };
  return apiKey;
});
