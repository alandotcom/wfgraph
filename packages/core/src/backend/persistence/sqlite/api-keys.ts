import { Effect } from "effect";
import { and, desc, eq, isNull, lte, or } from "drizzle-orm";
import { generateId } from "@wfgraph/shared/utils/id";
import { ApiKeyRepo } from "#src/backend/services/api-keys/repo";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import { apiKeys } from "#src/backend/persistence/sqlite/schema";

export function makeSqliteApiKeyRepo(
  store: SqliteDatabase
): ApiKeyRepo["Service"] {
  return {
    listNewestFirst: store.read((database) =>
      database
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          createdAt: apiKeys.createdAt,
          lastUsedAt: apiKeys.lastUsedAt,
        })
        .from(apiKeys)
        .orderBy(desc(apiKeys.createdAt))
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              ...row,
              createdAt: new Date(row.createdAt),
              lastUsedAt:
                row.lastUsedAt === null ? null : new Date(row.lastUsedAt),
            }))
          )
        )
    ),
    insert: (input) =>
      store.write((database) => {
        const id = generateId();
        const createdAt = new Date();
        return database
          .insert(apiKeys)
          .values({
            id,
            name: input.name,
            keyHash: input.keyHash,
            keyPrefix: input.keyPrefix,
            createdAt: createdAt.getTime(),
            lastUsedAt: null,
          })
          .pipe(
            Effect.as({
              id,
              name: input.name,
              keyPrefix: input.keyPrefix,
              createdAt,
              lastUsedAt: null,
            })
          );
      }),
    deleteById: (keyId) =>
      store.write((database) =>
        database
          .delete(apiKeys)
          .where(eq(apiKeys.id, keyId))
          .returning({ id: apiKeys.id })
          .pipe(Effect.map((rows) => rows.map((row) => row.id)))
      ),
    findByPrefix: (keyPrefix) =>
      store.read((database) =>
        database
          .select({ id: apiKeys.id, keyHash: apiKeys.keyHash })
          .from(apiKeys)
          .where(eq(apiKeys.keyPrefix, keyPrefix))
      ),
    touchLastUsed: (keyId) =>
      store.write((database) => {
        const now = Date.now();
        return database
          .update(apiKeys)
          .set({ lastUsedAt: now })
          .where(
            and(
              eq(apiKeys.id, keyId),
              or(
                isNull(apiKeys.lastUsedAt),
                lte(apiKeys.lastUsedAt, now - 60_000)
              )
            )
          );
      }),
  };
}
