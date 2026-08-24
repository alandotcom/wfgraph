import { Effect } from "effect";
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
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import {
  optionalBoolean,
  optionalDate,
  optionalString,
  placeholders,
  requiredDate,
  requiredNumber,
  requiredString,
} from "#src/backend/persistence/sqlite/database";

const INTEGRATION_COLUMNS =
  "id, name, type, config, config_revision, is_managed, refresh_state, refresh_claim_id, refresh_claimed_at, created_at, updated_at";

type StoredIntegration = Omit<DecryptedIntegration, "config"> & {
  config: string;
};

function refreshState(
  row: Record<string, unknown>
): StoredIntegration["refreshState"] {
  const value = requiredString(row, "refresh_state");
  if (
    value !== "idle" &&
    value !== "refreshing" &&
    value !== "reauthorization_required"
  ) {
    throw new Error("Invalid SQLite refresh_state");
  }
  return value;
}

function storedIntegration(row: Record<string, unknown>): StoredIntegration {
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
  const decryptOptional = (
    row: StoredIntegration | null
  ): Effect.Effect<DecryptedIntegration | null, EncryptionKeyMismatch> =>
    row ? decrypt(row) : Effect.succeed(null);
  type StoredWriteOutcome =
    | { status: "updated"; integration: StoredIntegration }
    | { status: "conflict" }
    | { status: "not_found" };
  const decryptWriteOutcome = (
    outcome: StoredWriteOutcome
  ): Effect.Effect<IntegrationWriteOutcome, EncryptionKeyMismatch> =>
    outcome.status === "updated"
      ? decrypt(outcome.integration).pipe(
          Effect.map((integration) => ({ status: "updated", integration }))
        )
      : Effect.succeed(outcome);

  return {
    listByType: (type) =>
      store
        .read((database) => {
          const rows = type
            ? database
                .prepare(
                  `SELECT ${INTEGRATION_COLUMNS} FROM integrations
                   WHERE type = ? ORDER BY created_at DESC`
                )
                .all(type)
            : database
                .prepare(
                  `SELECT ${INTEGRATION_COLUMNS} FROM integrations
                   ORDER BY created_at DESC`
                )
                .all();
          return rows.map(storedIntegration);
        })
        .pipe(Effect.flatMap((rows) => Effect.forEach(rows, decrypt))),
    findById: (integrationId) =>
      store
        .read((database) => {
          const row = database
            .prepare(
              `SELECT ${INTEGRATION_COLUMNS} FROM integrations WHERE id = ?`
            )
            .get(integrationId);
          return row ? storedIntegration(row) : null;
        })
        .pipe(Effect.flatMap(decryptOptional)),
    typesByIds: (integrationIds) =>
      store.read((database) => {
        if (integrationIds.length === 0) return {};
        return Object.fromEntries(
          database
            .prepare(
              `SELECT id, type FROM integrations
               WHERE id IN (${placeholders(integrationIds.length)})`
            )
            .all(...integrationIds)
            .map((row) => [
              requiredString(row, "id"),
              requiredString(row, "type"),
            ])
        );
      }),
    insert: (input) =>
      store.write((database) => {
        const id = generateId();
        const now = new Date();
        database
          .prepare(
            `INSERT INTO integrations
             (id, name, type, config, is_managed, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, ?, ?)`
          )
          .run(
            id,
            input.name,
            input.type,
            cipher.seal(input.config),
            now.getTime(),
            now.getTime()
          );
        return {
          id,
          name: input.name,
          type: input.type,
          config: input.config,
          configRevision: 0,
          isManaged: false,
          refreshState: "idle",
          refreshClaimId: null,
          refreshClaimedAt: null,
          createdAt: now,
          updatedAt: now,
        };
      }),
    update: (integrationId, updates) =>
      store
        .write((database) => {
          const current = database
            .prepare(
              `SELECT ${INTEGRATION_COLUMNS} FROM integrations WHERE id = ?`
            )
            .get(integrationId);
          if (!current) return { status: "not_found" as const };
          const row = storedIntegration(current);
          const updatedAt = new Date();
          const name = updates.name ?? row.name;
          const updated =
            updates.config === undefined
              ? database
                  .prepare(
                    `UPDATE integrations SET name = ?, updated_at = ?
                     WHERE id = ? RETURNING ${INTEGRATION_COLUMNS}`
                  )
                  .get(name, updatedAt.getTime(), integrationId)
              : database
                  .prepare(
                    `UPDATE integrations
                     SET name = ?, config = ?, config_revision = config_revision + 1,
                         updated_at = ?
                     WHERE id = ? AND config_revision = ? AND refresh_state <> 'refreshing'
                     RETURNING ${INTEGRATION_COLUMNS}`
                  )
                  .get(
                    name,
                    cipher.seal(updates.config),
                    updatedAt.getTime(),
                    integrationId,
                    updates.expectedRevision
                  );
          return updated
            ? {
                status: "updated" as const,
                integration: storedIntegration(updated),
              }
            : { status: "conflict" as const };
        })
        .pipe(Effect.flatMap(decryptWriteOutcome)),
    deleteById: (integrationId) =>
      store.write(
        (database) =>
          database
            .prepare("DELETE FROM integrations WHERE id = ? RETURNING id")
            .get(integrationId) !== undefined
      ),
    createOAuthAuthorizationAttempt: (input) =>
      store.write((database) => {
        database
          .prepare(
            "DELETE FROM oauth_authorization_attempts WHERE expires_at <= ?"
          )
          .run(Date.now());
        database
          .prepare(
            `INSERT INTO oauth_authorization_attempts
             (state_hash, integration_id, expires_at, browser_binding_hash, encrypted_payload, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.stateHash,
            input.integrationId,
            input.expiresAt.getTime(),
            input.browserBindingHash,
            cipher.seal({
              redirectUri: input.payload.redirectUri,
              configRevision: String(input.payload.configRevision),
              ...(input.payload.codeVerifier
                ? { codeVerifier: input.payload.codeVerifier }
                : {}),
            }),
            Date.now()
          );
      }),
    consumeOAuthAuthorizationAttempt: (stateHash, browserBindingHash) =>
      store
        .write((database) => {
          const row = database
            .prepare(
              `DELETE FROM oauth_authorization_attempts WHERE state_hash = ?
             RETURNING integration_id, expires_at, browser_binding_hash, encrypted_payload`
            )
            .get(stateHash);
          if (
            !row ||
            requiredString(row, "browser_binding_hash") !==
              browserBindingHash ||
            requiredDate(row, "expires_at").getTime() <= Date.now()
          ) {
            return null;
          }
          return {
            integrationId: requiredString(row, "integration_id"),
            encryptedPayload: requiredString(row, "encrypted_payload"),
          };
        })
        .pipe(
          Effect.flatMap((attempt) => {
            if (!attempt) {
              return Effect.succeed(null);
            }

            return cipher.open(attempt.encryptedPayload).pipe(
              Effect.map((config) => {
                const payload = readOAuthAuthorizationAttemptPayload(config);
                return payload
                  ? { integrationId: attempt.integrationId, payload }
                  : null;
              })
            );
          })
        ),
    claimRefresh: (input) =>
      store.write((database) => {
        const claimed = database
          .prepare(
            `UPDATE integrations
             SET refresh_state = 'refreshing', refresh_claim_id = ?, refresh_claimed_at = ?
             WHERE id = ? AND refresh_state <> 'refreshing' AND config_revision = ?
             RETURNING id`
          )
          .get(
            input.claimId,
            Date.now(),
            input.integrationId,
            input.expectedRevision
          );
        if (claimed) return { status: "acquired" };
        const existing = database
          .prepare("SELECT id FROM integrations WHERE id = ?")
          .get(input.integrationId);
        return existing ? { status: "lost" } : { status: "not_found" };
      }),
    completeRefresh: (input) =>
      store.write(
        (database) =>
          database
            .prepare(
              `UPDATE integrations
               SET config = ?, refresh_state = 'idle', refresh_claim_id = NULL,
                   refresh_claimed_at = NULL, config_revision = config_revision + 1,
                   updated_at = ?
               WHERE id = ? AND refresh_state = 'refreshing' AND refresh_claim_id = ?
                 AND config_revision = ?
               RETURNING id`
            )
            .get(
              cipher.seal(input.config),
              Date.now(),
              input.integrationId,
              input.claimId,
              input.expectedRevision
            ) !== undefined
      ),
    releaseRefreshClaim: (input) =>
      store.write(
        (database) =>
          database
            .prepare(
              `UPDATE integrations
               SET refresh_state = 'idle', refresh_claim_id = NULL, refresh_claimed_at = NULL
               WHERE id = ? AND refresh_state = 'refreshing' AND refresh_claim_id = ?
                 AND config_revision = ?
               RETURNING id`
            )
            .get(input.integrationId, input.claimId, input.expectedRevision) !==
          undefined
      ),
    markReauthorizationRequired: (input) =>
      store.write(
        (database) =>
          database
            .prepare(
              `UPDATE integrations
               SET refresh_state = 'reauthorization_required', refresh_claim_id = NULL,
                   refresh_claimed_at = NULL, updated_at = ?
               WHERE id = ? AND refresh_state = 'refreshing' AND refresh_claim_id = ?
                 AND config_revision = ?
               RETURNING id`
            )
            .get(
              Date.now(),
              input.integrationId,
              input.claimId,
              input.expectedRevision
            ) !== undefined
      ),
  };
}
