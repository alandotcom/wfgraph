import { and, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  integrations,
  oauthAuthorizationAttempts,
  type IntegrationRefreshState,
  type NewIntegration,
} from "#src/backend/lib/db/schema";
import { Database, type DatabaseError } from "#src/backend/lib/effect/database";
import type {
  EncryptionKeyMismatch,
  IntegrationCipher,
} from "#src/backend/services/integrations/cipher";
import type { IntegrationConfig } from "@wfgraph/shared/types/integration";

/** One `integrations` row, with its config opened out of the AES envelope. */
export type DecryptedIntegration = {
  id: string;
  name: string;
  type: string;
  config: IntegrationConfig;
  configRevision: number;
  isManaged: boolean | null;
  refreshState: IntegrationRefreshState;
  refreshClaimId: string | null;
  refreshClaimedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RefreshClaimOutcome =
  | { status: "acquired" }
  | { status: "lost" }
  | { status: "not_found" };

export type IntegrationWriteOutcome =
  | { status: "updated"; integration: DecryptedIntegration }
  | { status: "conflict" }
  | { status: "not_found" };

export type ConsumedOAuthAuthorizationAttempt = {
  integrationId: string;
  payload: OAuthAuthorizationAttemptPayload;
};

export type OAuthAuthorizationAttemptPayload = {
  redirectUri: string;
  configRevision: number;
  codeVerifier?: string;
};

export function readOAuthAuthorizationAttemptPayload(
  config: IntegrationConfig
): OAuthAuthorizationAttemptPayload | null {
  const redirectUri = config.redirectUri;
  const configRevision = Number(config.configRevision);
  if (
    !redirectUri ||
    !Number.isSafeInteger(configRevision) ||
    configRevision < 0
  ) {
    return null;
  }

  return {
    redirectUri,
    configRevision,
    ...(config.codeVerifier ? { codeVerifier: config.codeVerifier } : {}),
  };
}

type RefreshClaimInput = {
  integrationId: string;
  claimId: string;
  expectedRevision: number;
};

const ownedRefreshClaim = (input: RefreshClaimInput) =>
  and(
    eq(integrations.id, input.integrationId),
    eq(integrations.refreshState, "refreshing"),
    eq(integrations.refreshClaimId, input.claimId),
    eq(integrations.configRevision, input.expectedRevision)
  );

type IntegrationUpdate =
  | { name?: string; config?: never }
  | {
      name?: string;
      config: IntegrationConfig;
      expectedRevision: number;
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
    /** Config writes compare the revision and refuse an active refresh owner. */
    readonly update: (
      integrationId: string,
      updates: IntegrationUpdate
    ) => Effect.Effect<IntegrationWriteOutcome, ReadFailure>;
    /** Whether a row was actually removed. */
    readonly deleteById: (
      integrationId: string
    ) => Effect.Effect<boolean, DatabaseError>;
    readonly createOAuthAuthorizationAttempt: (input: {
      stateHash: string;
      integrationId: string;
      expiresAt: Date;
      browserBindingHash: string;
      payload: OAuthAuthorizationAttemptPayload;
    }) => Effect.Effect<void, DatabaseError>;
    /** Deletes the state before checking its expiry and browser binding. */
    readonly consumeOAuthAuthorizationAttempt: (
      stateHash: string,
      browserBindingHash: string
    ) => Effect.Effect<ConsumedOAuthAuthorizationAttempt | null, ReadFailure>;
    readonly claimRefresh: (
      input: RefreshClaimInput
    ) => Effect.Effect<RefreshClaimOutcome, DatabaseError>;
    readonly completeRefresh: (
      input: RefreshClaimInput & { config: IntegrationConfig }
    ) => Effect.Effect<boolean, DatabaseError>;
    readonly releaseRefreshClaim: (
      input: RefreshClaimInput
    ) => Effect.Effect<boolean, DatabaseError>;
    readonly markReauthorizationRequired: (
      input: RefreshClaimInput
    ) => Effect.Effect<boolean, DatabaseError>;
  }
>()("@wfgraph/core/IntegrationRepo") {}

/**
 * The live repository.
 *
 * The cipher is a parameter because the encryption key belongs to the app, the
 * same way the database handle does: `createWfGraphApp` builds one from its
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

      type StoredWriteOutcome =
        | { status: "updated"; row: typeof integrations.$inferSelect }
        | { status: "conflict" }
        | { status: "not_found" };

      const decryptedWriteOutcome = (
        outcome: StoredWriteOutcome
      ): Effect.Effect<IntegrationWriteOutcome, EncryptionKeyMismatch> => {
        if (outcome.status !== "updated") {
          return Effect.succeed(outcome);
        }
        return decrypted(outcome.row).pipe(
          Effect.map((integration) => ({ status: "updated", integration }))
        );
      };

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
            .query((db) =>
              db.transaction(async (tx): Promise<StoredWriteOutcome> => {
                const updateData: Partial<NewIntegration> = {
                  updatedAt: new Date(),
                };

                if (updates.name !== undefined) {
                  updateData.name = updates.name;
                }

                const changesConfig = updates.config !== undefined;
                if (changesConfig) {
                  updateData.config = cipher.seal(updates.config);
                }
                const versionedUpdateData = changesConfig
                  ? {
                      ...updateData,
                      configRevision: sql`${integrations.configRevision} + 1`,
                    }
                  : updateData;

                const rows = await tx
                  .update(integrations)
                  .set(versionedUpdateData)
                  .where(
                    changesConfig
                      ? and(
                          eq(integrations.id, integrationId),
                          eq(
                            integrations.configRevision,
                            updates.expectedRevision
                          ),
                          ne(integrations.refreshState, "refreshing")
                        )
                      : eq(integrations.id, integrationId)
                  )
                  .returning();
                if (rows[0]) {
                  return { status: "updated", row: rows[0] };
                }

                const existing = await tx
                  .select({ id: integrations.id })
                  .from(integrations)
                  .where(eq(integrations.id, integrationId))
                  .limit(1);
                return existing.length > 0
                  ? { status: "conflict" }
                  : { status: "not_found" };
              })
            )
            .pipe(Effect.flatMap(decryptedWriteOutcome)),

        deleteById: (integrationId) =>
          database.query(async (db) => {
            const removed = await db
              .delete(integrations)
              .where(eq(integrations.id, integrationId))
              .returning({ id: integrations.id });

            return removed.length > 0;
          }),

        createOAuthAuthorizationAttempt: (input) =>
          database.query((db) =>
            db.transaction(async (tx) => {
              await tx
                .delete(oauthAuthorizationAttempts)
                .where(lte(oauthAuthorizationAttempts.expiresAt, new Date()));
              await tx.insert(oauthAuthorizationAttempts).values({
                stateHash: input.stateHash,
                integrationId: input.integrationId,
                expiresAt: input.expiresAt,
                browserBindingHash: input.browserBindingHash,
                encryptedPayload: cipher.seal({
                  redirectUri: input.payload.redirectUri,
                  configRevision: String(input.payload.configRevision),
                  ...(input.payload.codeVerifier
                    ? { codeVerifier: input.payload.codeVerifier }
                    : {}),
                }),
              });
            })
          ),

        consumeOAuthAuthorizationAttempt: (stateHash, browserBindingHash) =>
          database
            .query(async (db) => {
              const [attempt] = await db
                .delete(oauthAuthorizationAttempts)
                .where(eq(oauthAuthorizationAttempts.stateHash, stateHash))
                .returning();

              if (
                !attempt ||
                attempt.browserBindingHash !== browserBindingHash ||
                attempt.expiresAt.getTime() <= Date.now()
              ) {
                return null;
              }

              return {
                integrationId: attempt.integrationId,
                encryptedPayload: attempt.encryptedPayload,
              };
            })
            .pipe(
              Effect.flatMap((attempt) => {
                if (!attempt) {
                  return Effect.succeed(null);
                }

                return cipher.open(attempt.encryptedPayload).pipe(
                  Effect.map((config) => {
                    const payload =
                      readOAuthAuthorizationAttemptPayload(config);
                    return payload
                      ? { integrationId: attempt.integrationId, payload }
                      : null;
                  })
                );
              })
            ),

        claimRefresh: (input) =>
          database.query((db) =>
            db.transaction(async (tx) => {
              const claimed = await tx
                .update(integrations)
                .set({
                  refreshState: "refreshing",
                  refreshClaimId: input.claimId,
                  refreshClaimedAt: new Date(),
                })
                .where(
                  and(
                    eq(integrations.id, input.integrationId),
                    ne(integrations.refreshState, "refreshing"),
                    eq(integrations.configRevision, input.expectedRevision)
                  )
                )
                .returning({ id: integrations.id });

              if (claimed.length > 0) {
                return { status: "acquired" as const };
              }

              const existing = await tx
                .select({ id: integrations.id })
                .from(integrations)
                .where(eq(integrations.id, input.integrationId))
                .limit(1);
              return existing.length > 0
                ? { status: "lost" as const }
                : { status: "not_found" as const };
            })
          ),

        completeRefresh: (input) =>
          database.query(async (db) => {
            const completed = await db
              .update(integrations)
              .set({
                config: cipher.seal(input.config),
                configRevision: sql`${integrations.configRevision} + 1`,
                refreshState: "idle",
                refreshClaimId: null,
                refreshClaimedAt: null,
                updatedAt: new Date(),
              })
              .where(ownedRefreshClaim(input))
              .returning({ id: integrations.id });
            return completed.length > 0;
          }),

        releaseRefreshClaim: (input) =>
          database.query(async (db) => {
            const released = await db
              .update(integrations)
              .set({
                refreshState: "idle",
                refreshClaimId: null,
                refreshClaimedAt: null,
              })
              .where(ownedRefreshClaim(input))
              .returning({ id: integrations.id });
            return released.length > 0;
          }),

        markReauthorizationRequired: (input) =>
          database.query(async (db) => {
            const transitioned = await db
              .update(integrations)
              .set({
                refreshState: "reauthorization_required",
                refreshClaimId: null,
                refreshClaimedAt: null,
                updatedAt: new Date(),
              })
              .where(ownedRefreshClaim(input))
              .returning({ id: integrations.id });
            return transitioned.length > 0;
          }),
      };
    })
  );
}
