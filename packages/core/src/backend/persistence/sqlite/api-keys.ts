import { generateId } from "@wfgraph/shared/utils/id";
import { ApiKeyRepo } from "#src/backend/services/api-keys/repo";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import {
  optionalDate,
  optionalString,
  requiredDate,
  requiredString,
} from "#src/backend/persistence/sqlite/database";

export function makeSqliteApiKeyRepo(
  store: SqliteDatabase
): ApiKeyRepo["Service"] {
  return {
    listNewestFirst: store.read((database) =>
      database
        .prepare(
          `SELECT id, name, key_prefix, created_at, last_used_at
           FROM api_keys ORDER BY created_at DESC`
        )
        .all()
        .map((row) => ({
          id: requiredString(row, "id"),
          name: optionalString(row, "name"),
          keyPrefix: requiredString(row, "key_prefix"),
          createdAt: requiredDate(row, "created_at"),
          lastUsedAt: optionalDate(row, "last_used_at"),
        }))
    ),
    insert: (input) =>
      store.write((database) => {
        const id = generateId();
        const createdAt = new Date();
        database
          .prepare(
            `INSERT INTO api_keys
             (id, name, key_hash, key_prefix, created_at, last_used_at)
             VALUES (?, ?, ?, ?, ?, NULL)`
          )
          .run(
            id,
            input.name,
            input.keyHash,
            input.keyPrefix,
            createdAt.getTime()
          );
        return {
          id,
          name: input.name,
          keyPrefix: input.keyPrefix,
          createdAt,
          lastUsedAt: null,
        };
      }),
    deleteById: (keyId) =>
      store.write((database) =>
        database
          .prepare("DELETE FROM api_keys WHERE id = ? RETURNING id")
          .all(keyId)
          .map((row) => requiredString(row, "id"))
      ),
    findByPrefix: (keyPrefix) =>
      store.read((database) =>
        database
          .prepare("SELECT id, key_hash FROM api_keys WHERE key_prefix = ?")
          .all(keyPrefix)
          .map((row) => ({
            id: requiredString(row, "id"),
            keyHash: requiredString(row, "key_hash"),
          }))
      ),
    touchLastUsed: (keyId) =>
      store.write((database) => {
        const now = Date.now();
        database
          .prepare(
            `UPDATE api_keys SET last_used_at = ?
             WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)`
          )
          .run(now, keyId, now - 60_000);
      }),
  };
}
