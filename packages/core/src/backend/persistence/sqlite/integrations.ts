import { Effect } from "effect";
import { and, desc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import { generateId } from "@wfgraph/shared/utils/id";
import { isIntegrationRefreshState } from "@wfgraph/shared/types/integration";
import type {
  EncryptionKeyMismatch,
  IntegrationCipher,
} from "#src/backend/services/integrations/cipher";
import {
  IntegrationRepo,
  type DecryptedIntegration,
  type IntegrationWriteOutcome,
  readOAuthAuthorizationAttemptPayload,
} from "#src/backend/services/integrations/repo";
import type {
  SqliteDatabase,
  SqliteExecutor,
} from "#src/backend/persistence/sqlite/database";
import {
  integrations,
  oauthAuthorizationAttempts,
} from "#src/backend/persistence/sqlite/schema";

type StoredIntegration = Omit<DecryptedIntegration, "config"> & {
  config: string;
};

function optionalManagedState(value: number | null): boolean | null {
  if (value === null) return null;
  if (value !== 0 && value !== 1) {
    throw new Error("Invalid SQLite is_managed");
  }
  return value === 1;
}

function refreshState(value: string): StoredIntegration["refreshState"] {
  if (!isIntegrationRefreshState(value)) {
    throw new Error("Invalid SQLite refresh_state");
  }
  return value;
}

function storedIntegration(
  row: typeof integrations.$inferSelect
): StoredIntegration {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: row.config,
    configRevision: row.configRevision,
    isManaged: optionalManagedState(row.isManaged),
    refreshState: refreshState(row.refreshState),
    refreshClaimId: row.refreshClaimId,
    refreshClaimedAt:
      row.refreshClaimedAt === null ? null : new Date(row.refreshClaimedAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function oauthAuthorizationAttemptStatus(
  status: string,
  resultIntegrationId: string | null
) {
  if (status === "pending" || status === "processing" || status === "failed") {
    return { status } as const;
  }
  if (status === "succeeded") {
    if (resultIntegrationId === null) {
      throw new Error("Invalid SQLite result_integration_id");
    }
    return { status, integrationId: resultIntegrationId } as const;
  }
  throw new Error("Invalid SQLite OAuth authorization attempt status");
}

export function makeSqliteIntegrationRepo(
  store: SqliteDatabase,
  cipher: IntegrationCipher
): IntegrationRepo["Service"] {
  const decrypt = (
    row: StoredIntegration
  ): Effect.Effect<DecryptedIntegration, EncryptionKeyMismatch> =>
    Effect.map(cipher.open(row.config), (config) => ({ ...row, config }));
  const decryptOptional = (row: StoredIntegration | null) =>
    row ? decrypt(row) : Effect.succeed(null);
  type StoredWriteOutcome =
    | { status: "updated"; integration: StoredIntegration }
    | { status: "conflict" }
    | { status: "not_found" };
  const decryptWriteOutcome = (outcome: StoredWriteOutcome) =>
    outcome.status === "updated"
      ? decrypt(outcome.integration).pipe(
          Effect.map((integration): IntegrationWriteOutcome => ({
            status: "updated",
            integration,
          }))
        )
      : Effect.succeed(outcome);

  return {
    listByType: (type) =>
      store
        .read((database) =>
          database
            .select()
            .from(integrations)
            .where(type ? eq(integrations.type, type) : undefined)
            .orderBy(desc(integrations.createdAt))
            .pipe(Effect.map((rows) => rows.map(storedIntegration)))
        )
        .pipe(Effect.flatMap((rows) => Effect.forEach(rows, decrypt))),
    listIdentities: store.read((database) =>
      database
        .select({ id: integrations.id, type: integrations.type })
        .from(integrations)
        .orderBy(desc(integrations.createdAt))
    ),
    findById: (integrationId) =>
      store
        .read((database) =>
          database
            .select()
            .from(integrations)
            .where(eq(integrations.id, integrationId))
            .pipe(
              Effect.map((rows) =>
                rows[0] === undefined ? null : storedIntegration(rows[0])
              )
            )
        )
        .pipe(Effect.flatMap(decryptOptional)),
    typesByIds: (integrationIds) =>
      integrationIds.length === 0
        ? Effect.succeed({})
        : store.read((database) =>
            database
              .select({ id: integrations.id, type: integrations.type })
              .from(integrations)
              .where(inArray(integrations.id, integrationIds))
              .pipe(
                Effect.map((rows) =>
                  Object.fromEntries(rows.map((row) => [row.id, row.type]))
                )
              )
          ),
    insert: (input) =>
      store.write((database) =>
        insertIntegration(database, cipher, { ...input, id: generateId() })
      ),
    insertWithId: (input) =>
      store.write((database) => insertIntegration(database, cipher, input)),
    update: (integrationId, updates) =>
      store
        .write((database) =>
          Effect.gen(function* () {
            const current = yield* database
              .select()
              .from(integrations)
              .where(eq(integrations.id, integrationId));
            const currentRow = current[0];
            if (currentRow === undefined)
              return { status: "not_found" as const };

            const row = storedIntegration(currentRow);
            const updatedAt = Date.now();
            const updated = yield* updates.config === undefined
              ? database
                  .update(integrations)
                  .set({ name: updates.name ?? row.name, updatedAt })
                  .where(eq(integrations.id, integrationId))
                  .returning()
              : database
                  .update(integrations)
                  .set({
                    name: updates.name ?? row.name,
                    config: cipher.seal(updates.config),
                    configRevision: sql`${integrations.configRevision} + 1`,
                    updatedAt,
                  })
                  .where(
                    and(
                      eq(integrations.id, integrationId),
                      eq(integrations.configRevision, updates.expectedRevision),
                      ne(integrations.refreshState, "refreshing")
                    )
                  )
                  .returning();
            const updatedRow = updated[0];
            return updatedRow === undefined
              ? ({ status: "conflict" } as const)
              : ({
                  status: "updated",
                  integration: storedIntegration(updatedRow),
                } as const);
          })
        )
        .pipe(Effect.flatMap(decryptWriteOutcome)),
    deleteOwnedRefreshClaim: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const removed = yield* database
            .delete(integrations)
            .where(
              and(
                eq(integrations.id, input.integrationId),
                eq(integrations.refreshState, "refreshing"),
                eq(integrations.refreshClaimId, input.claimId),
                eq(integrations.configRevision, input.expectedRevision)
              )
            )
            .returning({ id: integrations.id });
          if (removed[0] !== undefined) return { status: "deleted" as const };
          const existing = yield* database
            .select({ id: integrations.id })
            .from(integrations)
            .where(eq(integrations.id, input.integrationId));
          return existing[0] === undefined
            ? { status: "not_found" as const }
            : { status: "no_longer_owned" as const };
        })
      ),
    createOAuthAuthorizationAttempt: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const now = Date.now();
          const expiredReconnects = database
            .select({ stateHash: oauthAuthorizationAttempts.stateHash })
            .from(oauthAuthorizationAttempts)
            .where(
              and(
                eq(oauthAuthorizationAttempts.mode, "reconnect"),
                eq(oauthAuthorizationAttempts.status, "processing"),
                lte(oauthAuthorizationAttempts.expiresAt, now)
              )
            );
          yield* database
            .update(integrations)
            .set({
              refreshState: "reauthorization_required",
              refreshClaimId: null,
              refreshClaimedAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(integrations.refreshState, "refreshing"),
                inArray(integrations.refreshClaimId, expiredReconnects)
              )
            );
          yield* database
            .delete(oauthAuthorizationAttempts)
            .where(lte(oauthAuthorizationAttempts.expiresAt, now));
          yield* database.insert(oauthAuthorizationAttempts).values({
            stateHash: input.stateHash,
            integrationId: input.integrationId,
            expiresAt: input.expiresAt.getTime(),
            browserBindingHash: input.browserBindingHash,
            encryptedPayload: cipher.seal({
              payload: JSON.stringify(input.payload),
            }),
            mode: input.payload.kind,
            status: "pending",
            createdAt: now,
            updatedAt: now,
          });
        })
      ),
    claimOAuthAuthorizationAttempt: (input) =>
      store
        .write((database) =>
          Effect.gen(function* () {
            const now = Date.now();
            const claimed = yield* database
              .update(oauthAuthorizationAttempts)
              .set({
                status: sql`case when ${oauthAuthorizationAttempts.browserBindingHash} = ${input.browserBindingHash}
                  then 'processing' else 'failed' end`,
                expiresAt: input.expiresAt.getTime(),
                updatedAt: now,
              })
              .where(
                and(
                  eq(oauthAuthorizationAttempts.stateHash, input.stateHash),
                  eq(oauthAuthorizationAttempts.status, "pending"),
                  gt(oauthAuthorizationAttempts.expiresAt, now)
                )
              )
              .returning({
                integrationId: oauthAuthorizationAttempts.integrationId,
                browserBindingHash:
                  oauthAuthorizationAttempts.browserBindingHash,
                encryptedPayload: oauthAuthorizationAttempts.encryptedPayload,
              });
            const attempt = claimed[0];
            if (
              attempt === undefined ||
              attempt.browserBindingHash !== input.browserBindingHash
            ) {
              return null;
            }
            return {
              integrationId: attempt.integrationId,
              encryptedPayload: attempt.encryptedPayload,
            };
          })
        )
        .pipe(
          Effect.flatMap((attempt) => {
            if (!attempt) return Effect.succeed(null);
            return cipher.open(attempt.encryptedPayload).pipe(
              Effect.map((config) => {
                const payload = readOAuthAuthorizationAttemptPayload(config);
                if (!payload) return null;
                if (payload.kind === "create") {
                  return attempt.integrationId === null
                    ? { integrationId: null, payload }
                    : null;
                }
                return attempt.integrationId === null
                  ? null
                  : { integrationId: attempt.integrationId, payload };
              })
            );
          })
        ),
    readOAuthAuthorizationAttemptStatus: (input) =>
      store.read((database) =>
        database
          .select({
            status: oauthAuthorizationAttempts.status,
            resultIntegrationId: oauthAuthorizationAttempts.resultIntegrationId,
          })
          .from(oauthAuthorizationAttempts)
          .where(
            and(
              eq(oauthAuthorizationAttempts.stateHash, input.stateHash),
              eq(
                oauthAuthorizationAttempts.browserBindingHash,
                input.browserBindingHash
              ),
              gt(oauthAuthorizationAttempts.expiresAt, Date.now())
            )
          )
          .pipe(
            Effect.map((rows) => {
              const attempt = rows[0];
              return attempt === undefined
                ? null
                : oauthAuthorizationAttemptStatus(
                    attempt.status,
                    attempt.resultIntegrationId
                  );
            })
          )
      ),
    failOAuthAuthorizationAttempt: (input) =>
      store.write((database) =>
        database
          .update(oauthAuthorizationAttempts)
          .set({
            status: "failed",
            expiresAt: input.expiresAt.getTime(),
            updatedAt: Date.now(),
          })
          .where(
            and(
              eq(oauthAuthorizationAttempts.stateHash, input.stateHash),
              eq(oauthAuthorizationAttempts.status, "processing")
            )
          )
          .returning({ stateHash: oauthAuthorizationAttempts.stateHash })
          .pipe(Effect.map((rows) => rows[0] !== undefined))
      ),
    completeOAuthCreateAttempt: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const claim = yield* database
            .select({ stateHash: oauthAuthorizationAttempts.stateHash })
            .from(oauthAuthorizationAttempts)
            .where(
              and(
                eq(oauthAuthorizationAttempts.stateHash, input.stateHash),
                eq(oauthAuthorizationAttempts.mode, "create"),
                eq(oauthAuthorizationAttempts.status, "processing")
              )
            );
          if (claim[0] === undefined) return false;
          const now = Date.now();
          yield* database.insert(integrations).values({
            id: input.integrationId,
            name: input.name,
            type: input.type,
            config: cipher.seal(input.config),
            isManaged: 0,
            createdAt: now,
            updatedAt: now,
          });
          yield* database
            .update(oauthAuthorizationAttempts)
            .set({
              status: "succeeded",
              resultIntegrationId: input.integrationId,
              expiresAt: input.expiresAt.getTime(),
              updatedAt: now,
            })
            .where(
              and(
                eq(oauthAuthorizationAttempts.stateHash, input.stateHash),
                eq(oauthAuthorizationAttempts.mode, "create"),
                eq(oauthAuthorizationAttempts.status, "processing")
              )
            );
          return true;
        })
      ),
    completeOAuthReconnectAttempt: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const attempt = yield* database
            .select({ stateHash: oauthAuthorizationAttempts.stateHash })
            .from(oauthAuthorizationAttempts)
            .where(
              and(
                eq(oauthAuthorizationAttempts.stateHash, input.stateHash),
                eq(
                  oauthAuthorizationAttempts.integrationId,
                  input.integrationId
                ),
                eq(oauthAuthorizationAttempts.mode, "reconnect"),
                eq(oauthAuthorizationAttempts.status, "processing")
              )
            );
          if (attempt[0] === undefined) return false;
          const now = Date.now();
          const integration = yield* database
            .update(integrations)
            .set({
              config: cipher.seal(input.config),
              refreshState: "idle",
              refreshClaimId: null,
              refreshClaimedAt: null,
              configRevision: sql`${integrations.configRevision} + 1`,
              updatedAt: now,
            })
            .where(
              and(
                eq(integrations.id, input.integrationId),
                eq(integrations.refreshState, "refreshing"),
                eq(integrations.refreshClaimId, input.stateHash),
                eq(integrations.configRevision, input.expectedRevision)
              )
            )
            .returning({ id: integrations.id });
          if (integration[0] === undefined) return false;
          yield* database
            .update(oauthAuthorizationAttempts)
            .set({
              status: "succeeded",
              resultIntegrationId: input.integrationId,
              expiresAt: input.expiresAt.getTime(),
              updatedAt: now,
            })
            .where(
              and(
                eq(oauthAuthorizationAttempts.stateHash, input.stateHash),
                eq(
                  oauthAuthorizationAttempts.integrationId,
                  input.integrationId
                ),
                eq(oauthAuthorizationAttempts.mode, "reconnect"),
                eq(oauthAuthorizationAttempts.status, "processing")
              )
            );
          return true;
        })
      ),
    claimRefresh: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const claimed = yield* database
            .update(integrations)
            .set({
              refreshState: "refreshing",
              refreshClaimId: input.claimId,
              refreshClaimedAt: Date.now(),
            })
            .where(
              and(
                eq(integrations.id, input.integrationId),
                ne(integrations.refreshState, "refreshing"),
                eq(integrations.configRevision, input.expectedRevision)
              )
            )
            .returning({ id: integrations.id });
          if (claimed[0] !== undefined) return { status: "acquired" as const };
          const existing = yield* database
            .select({ id: integrations.id })
            .from(integrations)
            .where(eq(integrations.id, input.integrationId));
          return existing[0] === undefined
            ? { status: "not_found" as const }
            : { status: "lost" as const };
        })
      ),
    completeRefresh: (input) =>
      store.write((database) =>
        database
          .update(integrations)
          .set({
            config: cipher.seal(input.config),
            refreshState: "idle",
            refreshClaimId: null,
            refreshClaimedAt: null,
            configRevision: sql`${integrations.configRevision} + 1`,
            updatedAt: Date.now(),
          })
          .where(ownedRefreshCondition(input))
          .returning({ id: integrations.id })
          .pipe(Effect.map((rows) => rows[0] !== undefined))
      ),
    releaseRefreshClaim: (input) =>
      store.write((database) =>
        database
          .update(integrations)
          .set({
            refreshState: "idle",
            refreshClaimId: null,
            refreshClaimedAt: null,
          })
          .where(ownedRefreshCondition(input))
          .returning({ id: integrations.id })
          .pipe(Effect.map((rows) => rows[0] !== undefined))
      ),
    markReauthorizationRequired: (input) =>
      store.write((database) =>
        database
          .update(integrations)
          .set({
            refreshState: "reauthorization_required",
            refreshClaimId: null,
            refreshClaimedAt: null,
            updatedAt: Date.now(),
          })
          .where(ownedRefreshCondition(input))
          .returning({ id: integrations.id })
          .pipe(
            Effect.map((rows) =>
              rows[0] === undefined
                ? ({ status: "no_longer_owned" } as const)
                : ({ status: "transitioned" } as const)
            )
          )
      ),
  };
}

function insertIntegration(
  database: SqliteExecutor,
  cipher: IntegrationCipher,
  input: {
    id: string;
    name: string;
    type: string;
    config: DecryptedIntegration["config"];
  }
) {
  const now = new Date();
  return database
    .insert(integrations)
    .values({
      id: input.id,
      name: input.name,
      type: input.type,
      config: cipher.seal(input.config),
      isManaged: 0,
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    })
    .pipe(
      Effect.as({
        ...input,
        configRevision: 0,
        isManaged: false,
        refreshState: "idle" as const,
        refreshClaimId: null,
        refreshClaimedAt: null,
        createdAt: now,
        updatedAt: now,
      })
    );
}

function ownedRefreshCondition(input: {
  integrationId: string;
  claimId: string;
  expectedRevision: number;
}) {
  return and(
    eq(integrations.id, input.integrationId),
    eq(integrations.refreshState, "refreshing"),
    eq(integrations.refreshClaimId, input.claimId),
    eq(integrations.configRevision, input.expectedRevision)
  );
}
