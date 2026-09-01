import { Effect } from "effect";
import { sql } from "drizzle-orm";
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
        .all<Record<string, unknown>>(sql`
          select id, name, key_prefix, created_at, last_used_at
          from api_keys order by created_at desc
        `)
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              id: requiredString(row, "id"),
              name: optionalString(row, "name"),
              keyPrefix: requiredString(row, "key_prefix"),
              createdAt: requiredDate(row, "created_at"),
              lastUsedAt: optionalDate(row, "last_used_at"),
            }))
          )
        )
    ),
    insert: (input) =>
      store.write((database) => {
        const id = generateId();
        const createdAt = new Date();
        return database
          .run(sql`
            insert into api_keys
              (id, name, key_hash, key_prefix, created_at, last_used_at)
            values (
              ${id}, ${input.name}, ${input.keyHash}, ${input.keyPrefix},
              ${createdAt.getTime()}, null
            )
          `)
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
          .all<Record<string, unknown>>(
            sql`delete from api_keys where id = ${keyId} returning id`
          )
          .pipe(
            Effect.map((rows) => rows.map((row) => requiredString(row, "id")))
          )
      ),
    findByPrefix: (keyPrefix) =>
      store.read((database) =>
        database
          .all<Record<string, unknown>>(
            sql`select id, key_hash from api_keys where key_prefix = ${keyPrefix}`
          )
          .pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                id: requiredString(row, "id"),
                keyHash: requiredString(row, "key_hash"),
              }))
            )
          )
      ),
    touchLastUsed: (keyId) =>
      store.write((database) => {
        const now = Date.now();
        return database.run(sql`
          update api_keys set last_used_at = ${now}
          where id = ${keyId}
            and (last_used_at is null or last_used_at <= ${now - 60_000})
        `);
      }),
  };
}
