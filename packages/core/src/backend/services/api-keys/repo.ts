import { Context, Effect, Layer } from "effect";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { apiKeys } from "#src/backend/lib/db/schema";
import { Database, type DatabaseError } from "#src/backend/lib/effect/database";

/** An API key as the management screens see it, without the hash. */
export type ApiKeySummary = {
  id: string;
  name: string | null;
  keyPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

/** What verification compares an incoming key against. */
export type ApiKeyCandidate = {
  id: string;
  keyHash: string;
};

/**
 * Every database question the API key services ask.
 *
 * The domain code above it never names a table or a column, which is what lets a
 * test provide answers directly instead of standing up a database. It is also
 * where ADR-0005's rule lands in practice: Drizzle stays, held behind a service,
 * and a query failure arrives as a typed `DatabaseError` rather than a rejected
 * promise.
 */
export class ApiKeyRepo extends Context.Service<
  ApiKeyRepo,
  {
    /** Newest first, which is the order the settings list shows. */
    readonly listNewestFirst: () => Effect.Effect<
      ApiKeySummary[],
      DatabaseError
    >;
    readonly insert: (input: {
      name: string | null;
      keyHash: string;
      keyPrefix: string;
    }) => Effect.Effect<ApiKeySummary, DatabaseError>;
    /** The ids actually removed, empty when the key was already gone. */
    readonly deleteById: (
      keyId: string
    ) => Effect.Effect<string[], DatabaseError>;
    /**
     * Every stored key sharing an incoming key's visible prefix. The prefix is
     * indexed and the hash is not, so this is what narrows a verification to a
     * handful of bcrypt comparisons.
     */
    readonly findByPrefix: (
      keyPrefix: string
    ) => Effect.Effect<ApiKeyCandidate[], DatabaseError>;
    readonly touchLastUsed: (
      keyId: string
    ) => Effect.Effect<void, DatabaseError>;
  }
>()("@rova/core/ApiKeyRepo") {}

export const ApiKeyRepoLayer: Layer.Layer<ApiKeyRepo, never, Database> =
  Layer.effect(
    ApiKeyRepo,
    Effect.gen(function* () {
      const database = yield* Database;

      return {
        listNewestFirst: () =>
          database.query((db) =>
            db.query.apiKeys.findMany({
              columns: {
                id: true,
                name: true,
                keyPrefix: true,
                createdAt: true,
                lastUsedAt: true,
              },
              orderBy: (table, { desc }) => [desc(table.createdAt)],
            })
          ),

        insert: (input) =>
          database.query(async (db) => {
            const [inserted] = await db
              .insert(apiKeys)
              .values({
                name: input.name,
                keyHash: input.keyHash,
                keyPrefix: input.keyPrefix,
              })
              .returning({
                id: apiKeys.id,
                name: apiKeys.name,
                keyPrefix: apiKeys.keyPrefix,
                createdAt: apiKeys.createdAt,
                lastUsedAt: apiKeys.lastUsedAt,
              });

            return inserted;
          }),

        deleteById: (keyId) =>
          database.query(async (db) => {
            const deleted = await db
              .delete(apiKeys)
              .where(eq(apiKeys.id, keyId))
              .returning({ id: apiKeys.id });

            return deleted.map((row) => row.id);
          }),

        findByPrefix: (keyPrefix) =>
          database.query((db) =>
            db.query.apiKeys.findMany({
              where: eq(apiKeys.keyPrefix, keyPrefix),
              columns: {
                id: true,
                keyHash: true,
              },
            })
          ),

        // Conditioned on staleness, so the ordinary request -- a key used more
        // than once a minute -- skips the write and the row lock it would take.
        // Awaiting the send is only cheap because almost every call takes this
        // branch; see auth.ts for why the send is awaited at all.
        // `last_used_at` is timezone-naive UTC, so the comparand has to be
        // framed the same way rather than compared against the session's own zone.
        touchLastUsed: (keyId) =>
          database.query(async (db) => {
            await db
              .update(apiKeys)
              .set({ lastUsedAt: new Date() })
              .where(
                and(
                  eq(apiKeys.id, keyId),
                  or(
                    isNull(apiKeys.lastUsedAt),
                    lt(
                      apiKeys.lastUsedAt,
                      sql`(now() at time zone 'utc') - interval '1 minute'`
                    )
                  )
                )
              );
          }),
      };
    })
  );
