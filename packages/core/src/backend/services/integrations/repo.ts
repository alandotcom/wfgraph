import { eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { integrations, type NewIntegration } from "#src/backend/lib/db/schema";
import { Database, type DatabaseError } from "#src/backend/lib/effect/database";
import type {
  EncryptionKeyMismatch,
  IntegrationCipher,
} from "#src/backend/services/integrations/cipher";
import type { IntegrationConfig } from "@rova/shared/types/integration";

/** One `integrations` row, with its config opened out of the AES envelope. */
export type DecryptedIntegration = {
  id: string;
  name: string;
  type: string;
  config: IntegrationConfig;
  isManaged: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * What a read that opens a stored config can fail with.
 *
 * The three methods carrying this are the three that open one; every other
 * method answers rows the cipher never sees, so it stays at `DatabaseError`.
 */
type ReadFailure = DatabaseError | EncryptionKeyMismatch;

/**
 * Every database question the integration services ask.
 *
 * The domain code above it never names a table, a column, or the encryption that
 * wraps a stored config, which is what lets a test answer these directly instead
 * of standing up a database and a key. A query failure arrives as a typed
 * `DatabaseError` rather than a rejected promise, the way ADR-0005 describes.
 */
export class IntegrationRepo extends Context.Service<
  IntegrationRepo,
  {
    /** Every integration, or only those of one type. */
    readonly listByType: (
      type?: string
    ) => Effect.Effect<DecryptedIntegration[], ReadFailure>;
    readonly findById: (
      integrationId: string
    ) => Effect.Effect<DecryptedIntegration | null, ReadFailure>;
    /**
     * The type of each id named, keyed by id, leaving out the ids no row
     * carries. One read answers both questions a graph asks about its
     * integrations: whether each exists, and whether it is the type its action
     * needs.
     */
    readonly typesByIds: (
      integrationIds: string[]
    ) => Effect.Effect<Record<string, string>, DatabaseError>;
    readonly insert: (input: {
      name: string;
      type: string;
      config: IntegrationConfig;
    }) => Effect.Effect<DecryptedIntegration, DatabaseError>;
    /** Null when the row was gone by the time the update ran. */
    readonly update: (
      integrationId: string,
      updates: { name?: string; config?: IntegrationConfig }
    ) => Effect.Effect<DecryptedIntegration | null, ReadFailure>;
    /** Whether a row was actually removed. */
    readonly deleteById: (
      integrationId: string
    ) => Effect.Effect<boolean, DatabaseError>;
  }
>()("@rova/core/IntegrationRepo") {}

/**
 * The live repository.
 *
 * The cipher is a parameter because the encryption key belongs to the app, the
 * same way the database handle does: `createRovaApp` builds one from its
 * `encryption` option and the Layer graph carries it here. Opening a row is its
 * own step after the query, which is what gives a rotated key its own tag:
 * crypto inside the query callback surfaces as a `DatabaseError`.
 */
export function makeIntegrationRepoLayer(
  cipher: IntegrationCipher
): Layer.Layer<IntegrationRepo, never, Database> {
  return Layer.effect(
    IntegrationRepo,
    Effect.gen(function* () {
      const database = yield* Database;

      const decrypted = (
        row: typeof integrations.$inferSelect
      ): Effect.Effect<DecryptedIntegration, EncryptionKeyMismatch> =>
        Effect.map(cipher.open(row.config), (config) => ({ ...row, config }));

      /** The first row opened, for the two reads that select at most one. */
      const decryptedOrNull = (
        rows: (typeof integrations.$inferSelect)[]
      ): Effect.Effect<DecryptedIntegration | null, EncryptionKeyMismatch> =>
        rows[0] ? decrypted(rows[0]) : Effect.succeed(null);

      return {
        listByType: (type) =>
          database
            .query(async (db) =>
              type
                ? db
                    .select()
                    .from(integrations)
                    .where(eq(integrations.type, type))
                : db.select().from(integrations)
            )
            .pipe(Effect.flatMap((rows) => Effect.forEach(rows, decrypted))),

        findById: (integrationId) =>
          database
            .query(async (db) =>
              db
                .select()
                .from(integrations)
                .where(eq(integrations.id, integrationId))
                .limit(1)
            )
            .pipe(Effect.flatMap(decryptedOrNull)),

        typesByIds: (integrationIds) =>
          database.query(async (db) => {
            if (integrationIds.length === 0) {
              return {};
            }

            const rows = await db
              .select({ id: integrations.id, type: integrations.type })
              .from(integrations)
              .where(inArray(integrations.id, integrationIds));

            return Object.fromEntries(rows.map((row) => [row.id, row.type]));
          }),

        insert: (input) =>
          database.query(async (db) => {
            const [row] = await db
              .insert(integrations)
              .values({
                name: input.name,
                type: input.type,
                config: cipher.seal(input.config),
              })
              .returning();

            // The config the caller handed over, rather than a round trip
            // through the envelope that would answer the same thing.
            return { ...row, config: input.config };
          }),

        update: (integrationId, updates) =>
          database
            .query(async (db) => {
              const updateData: Partial<NewIntegration> = {
                updatedAt: new Date(),
              };

              if (updates.name !== undefined) {
                updateData.name = updates.name;
              }

              if (updates.config !== undefined) {
                updateData.config = cipher.seal(updates.config);
              }

              return db
                .update(integrations)
                .set(updateData)
                .where(eq(integrations.id, integrationId))
                .returning();
            })
            .pipe(Effect.flatMap(decryptedOrNull)),

        deleteById: (integrationId) =>
          database.query(async (db) => {
            const removed = await db
              .delete(integrations)
              .where(eq(integrations.id, integrationId))
              .returning({ id: integrations.id });

            return removed.length > 0;
          }),
      };
    })
  );
}
