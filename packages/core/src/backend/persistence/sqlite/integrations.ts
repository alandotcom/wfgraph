import { Effect } from "effect";
import { sql } from "drizzle-orm";
import { generateId } from "@wfgraph/shared/utils/id";
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
import { isIntegrationRefreshState } from "@wfgraph/shared/types/integration";
import {
  optionalBoolean,
  optionalDate,
  optionalString,
  placeholders,
  requiredDate,
  requiredNumber,
  requiredString,
} from "#src/backend/persistence/sqlite/database";

const INTEGRATION_COLUMNS = sql.raw(
  "id, name, type, config, config_revision, is_managed, refresh_state, refresh_claim_id, refresh_claimed_at, created_at, updated_at"
);
type Row = Record<string, unknown>;
type StoredIntegration = Omit<DecryptedIntegration, "config"> & {
  config: string;
};

function refreshState(row: Row): StoredIntegration["refreshState"] {
  const value = requiredString(row, "refresh_state");
  if (!isIntegrationRefreshState(value)) {
    throw new Error("Invalid SQLite refresh_state");
  }
  return value;
}

function storedIntegration(row: Row): StoredIntegration {
  return {
    id: requiredString(row, "id"),
    name: requiredString(row, "name"),
    type: requiredString(row, "type"),
    config: requiredString(row, "config"),
    configRevision: requiredNumber(row, "config_revision"),
    isManaged: optionalBoolean(row, "is_managed"),
    refreshState: refreshState(row),
    refreshClaimId: optionalString(row, "refresh_claim_id"),
    refreshClaimedAt: optionalDate(row, "refresh_claimed_at"),
    createdAt: requiredDate(row, "created_at"),
    updatedAt: requiredDate(row, "updated_at"),
  };
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
            .all<Row>(sql`
              select ${INTEGRATION_COLUMNS} from integrations
              ${type ? sql`where type = ${type}` : sql.empty()}
              order by created_at desc
            `)
            .pipe(Effect.map((rows) => rows.map(storedIntegration)))
        )
        .pipe(Effect.flatMap((rows) => Effect.forEach(rows, decrypt))),
    findById: (integrationId) =>
      store
        .read((database) =>
          database
            .get<Row>(sql`
              select ${INTEGRATION_COLUMNS} from integrations
              where id = ${integrationId}
            `)
            .pipe(Effect.map((row) => (row ? storedIntegration(row) : null)))
        )
        .pipe(Effect.flatMap(decryptOptional)),
    typesByIds: (integrationIds) =>
      integrationIds.length === 0
        ? Effect.succeed({})
        : store.read((database) =>
            database
              .all<Row>(sql`
                select id, type from integrations
                where id in (${placeholders(integrationIds)})
              `)
              .pipe(
                Effect.map((rows) =>
                  Object.fromEntries(
                    rows.map((row) => [
                      requiredString(row, "id"),
                      requiredString(row, "type"),
                    ])
                  )
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
            const current = yield* database.get<Row>(sql`
              select ${INTEGRATION_COLUMNS} from integrations where id = ${integrationId}
            `);
            if (!current) return { status: "not_found" as const };
            const row = storedIntegration(current);
            const updatedAt = Date.now();
            const updated = yield* updates.config === undefined
              ? database.get<Row>(sql`
                  update integrations set name = ${updates.name ?? row.name},
                    updated_at = ${updatedAt}
                  where id = ${integrationId} returning ${INTEGRATION_COLUMNS}
                `)
              : database.get<Row>(sql`
                  update integrations set name = ${updates.name ?? row.name},
                    config = ${cipher.seal(updates.config)},
                    config_revision = config_revision + 1, updated_at = ${updatedAt}
                  where id = ${integrationId}
                    and config_revision = ${updates.expectedRevision}
                    and refresh_state <> 'refreshing'
                  returning ${INTEGRATION_COLUMNS}
                `);
            return updated
              ? ({
                  status: "updated",
                  integration: storedIntegration(updated),
                } as const)
              : ({ status: "conflict" } as const);
          })
        )
        .pipe(Effect.flatMap(decryptWriteOutcome)),
    deleteOwnedRefreshClaim: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const removed = yield* database.get<Row>(sql`
            delete from integrations where id = ${input.integrationId}
              and refresh_state = 'refreshing'
              and refresh_claim_id = ${input.claimId}
              and config_revision = ${input.expectedRevision}
            returning id
          `);
          if (removed) return { status: "deleted" as const };
          const existing = yield* database.get<Row>(
            sql`select id from integrations where id = ${input.integrationId}`
          );
          return existing
            ? { status: "no_longer_owned" as const }
            : { status: "not_found" as const };
        })
      ),
    createOAuthAuthorizationAttempt: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const now = Date.now();
          yield* database.run(sql`
            update integrations set refresh_state = 'reauthorization_required',
              refresh_claim_id = null, refresh_claimed_at = null, updated_at = ${now}
            where refresh_state = 'refreshing' and refresh_claim_id in (
              select state_hash from oauth_authorization_attempts
              where mode = 'reconnect' and status = 'processing' and expires_at <= ${now}
            )
          `);
          yield* database.run(
            sql`delete from oauth_authorization_attempts where expires_at <= ${now}`
          );
          yield* database.run(sql`
            insert into oauth_authorization_attempts (
              state_hash, integration_id, expires_at, browser_binding_hash,
              encrypted_payload, mode, status, created_at, updated_at
            ) values (
              ${input.stateHash}, ${input.integrationId}, ${input.expiresAt.getTime()},
              ${input.browserBindingHash},
              ${cipher.seal({ payload: JSON.stringify(input.payload) })},
              ${input.payload.kind}, 'pending', ${now}, ${now}
            )
          `);
        })
      ),
    claimOAuthAuthorizationAttempt: (input) =>
      store
        .write((database) =>
          Effect.gen(function* () {
            const now = Date.now();
            const row = yield* database.get<Row>(sql`
              update oauth_authorization_attempts
              set status = case when browser_binding_hash = ${input.browserBindingHash}
                    then 'processing' else 'failed' end,
                  expires_at = ${input.expiresAt.getTime()}, updated_at = ${now}
              where state_hash = ${input.stateHash} and status = 'pending'
                and expires_at > ${now}
              returning integration_id, browser_binding_hash, encrypted_payload
            `);
            if (
              !row ||
              requiredString(row, "browser_binding_hash") !==
                input.browserBindingHash
            ) {
              return null;
            }
            return {
              integrationId: optionalString(row, "integration_id"),
              encryptedPayload: requiredString(row, "encrypted_payload"),
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
          .get<Row>(sql`
            select status, result_integration_id from oauth_authorization_attempts
            where state_hash = ${input.stateHash}
              and browser_binding_hash = ${input.browserBindingHash}
              and expires_at > ${Date.now()}
          `)
          .pipe(
            Effect.map((row) => {
              if (!row) return null;
              const status = requiredString(row, "status");
              if (status === "pending" || status === "processing") {
                return { status } as const;
              }
              if (status === "failed") return { status } as const;
              if (status === "succeeded") {
                return {
                  status,
                  integrationId: requiredString(row, "result_integration_id"),
                } as const;
              }
              throw new Error(
                "Invalid SQLite OAuth authorization attempt status"
              );
            })
          )
      ),
    failOAuthAuthorizationAttempt: (input) =>
      store.write((database) =>
        database
          .get<Row>(sql`
            update oauth_authorization_attempts set status = 'failed',
              expires_at = ${input.expiresAt.getTime()}, updated_at = ${Date.now()}
            where state_hash = ${input.stateHash} and status = 'processing'
            returning state_hash
          `)
          .pipe(Effect.map(Boolean))
      ),
    completeOAuthCreateAttempt: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const claim = yield* database.get<Row>(sql`
            select state_hash from oauth_authorization_attempts
            where state_hash = ${input.stateHash} and mode = 'create'
              and status = 'processing'
          `);
          if (!claim) return false;
          const now = Date.now();
          yield* database.run(sql`
            insert into integrations
              (id, name, type, config, is_managed, created_at, updated_at)
            values (${input.integrationId}, ${input.name}, ${input.type},
              ${cipher.seal(input.config)}, 0, ${now}, ${now})
          `);
          yield* database.run(sql`
            update oauth_authorization_attempts set status = 'succeeded',
              result_integration_id = ${input.integrationId},
              expires_at = ${input.expiresAt.getTime()}, updated_at = ${now}
            where state_hash = ${input.stateHash} and mode = 'create'
              and status = 'processing'
          `);
          return true;
        })
      ),
    completeOAuthReconnectAttempt: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const attempt = yield* database.get<Row>(sql`
            select state_hash from oauth_authorization_attempts
            where state_hash = ${input.stateHash}
              and integration_id = ${input.integrationId}
              and mode = 'reconnect' and status = 'processing'
          `);
          if (!attempt) return false;
          const now = Date.now();
          const integration = yield* database.get<Row>(sql`
            update integrations set config = ${cipher.seal(input.config)},
              refresh_state = 'idle', refresh_claim_id = null,
              refresh_claimed_at = null, config_revision = config_revision + 1,
              updated_at = ${now}
            where id = ${input.integrationId} and refresh_state = 'refreshing'
              and refresh_claim_id = ${input.stateHash}
              and config_revision = ${input.expectedRevision}
            returning id
          `);
          if (!integration) return false;
          yield* database.run(sql`
            update oauth_authorization_attempts set status = 'succeeded',
              result_integration_id = ${input.integrationId},
              expires_at = ${input.expiresAt.getTime()}, updated_at = ${now}
            where state_hash = ${input.stateHash}
              and integration_id = ${input.integrationId}
              and mode = 'reconnect' and status = 'processing'
          `);
          return true;
        })
      ),
    claimRefresh: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          const claimed = yield* database.get<Row>(sql`
            update integrations set refresh_state = 'refreshing',
              refresh_claim_id = ${input.claimId}, refresh_claimed_at = ${Date.now()}
            where id = ${input.integrationId} and refresh_state <> 'refreshing'
              and config_revision = ${input.expectedRevision}
            returning id
          `);
          if (claimed) return { status: "acquired" as const };
          const existing = yield* database.get<Row>(
            sql`select id from integrations where id = ${input.integrationId}`
          );
          return existing
            ? { status: "lost" as const }
            : { status: "not_found" as const };
        })
      ),
    completeRefresh: (input) =>
      ownedRefreshUpdate(
        store,
        input,
        () => sql`
          config = ${cipher.seal(input.config)}, refresh_state = 'idle',
          refresh_claim_id = null, refresh_claimed_at = null,
          config_revision = config_revision + 1, updated_at = ${Date.now()}
        `
      ),
    releaseRefreshClaim: (input) =>
      ownedRefreshUpdate(
        store,
        input,
        () => sql`
          refresh_state = 'idle', refresh_claim_id = null, refresh_claimed_at = null
        `
      ),
    markReauthorizationRequired: (input) =>
      store.write((database) =>
        database
          .get<Row>(sql`
            update integrations set refresh_state = 'reauthorization_required',
              refresh_claim_id = null, refresh_claimed_at = null,
              updated_at = ${Date.now()}
            where id = ${input.integrationId} and refresh_state = 'refreshing'
              and refresh_claim_id = ${input.claimId}
              and config_revision = ${input.expectedRevision}
            returning id
          `)
          .pipe(
            Effect.map((row) =>
              row
                ? ({ status: "transitioned" } as const)
                : ({ status: "no_longer_owned" } as const)
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
    .run(sql`
      insert into integrations
        (id, name, type, config, is_managed, created_at, updated_at)
      values (${input.id}, ${input.name}, ${input.type},
        ${cipher.seal(input.config)}, 0, ${now.getTime()}, ${now.getTime()})
    `)
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

function ownedRefreshUpdate(
  store: SqliteDatabase,
  input: {
    integrationId: string;
    claimId: string;
    expectedRevision: number;
  },
  assignments: () => ReturnType<typeof sql>
) {
  return store.write((database) =>
    database
      .get<Row>(sql`
        update integrations set ${assignments()}
        where id = ${input.integrationId} and refresh_state = 'refreshing'
          and refresh_claim_id = ${input.claimId}
          and config_revision = ${input.expectedRevision}
        returning id
      `)
      .pipe(Effect.map(Boolean))
  );
}
