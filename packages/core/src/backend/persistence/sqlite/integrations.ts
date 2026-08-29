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

const INTEGRATION_COLUMNS =
  "id, name, type, config, config_revision, is_managed, refresh_state, refresh_claim_id, refresh_claimed_at, created_at, updated_at";

type StoredIntegration = Omit<DecryptedIntegration, "config"> & {
  config: string;
};

function refreshState(
  row: Record<string, unknown>
): StoredIntegration["refreshState"] {
  const value = requiredString(row, "refresh_state");
  if (!isIntegrationRefreshState(value)) {
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
    insertWithId: (input) =>
      store.write((database) => {
        const now = new Date();
        database
          .prepare(
            `INSERT INTO integrations
             (id, name, type, config, is_managed, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, ?, ?)`
          )
          .run(
            input.id,
            input.name,
            input.type,
            cipher.seal(input.config),
            now.getTime(),
            now.getTime()
          );
        return {
          id: input.id,
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
    deleteOwnedRefreshClaim: (input) =>
      store.write((database) => {
        const removed = database
          .prepare(
            `DELETE FROM integrations
             WHERE id = ? AND refresh_state = 'refreshing'
               AND refresh_claim_id = ? AND config_revision = ?
             RETURNING id`
          )
          .get(input.integrationId, input.claimId, input.expectedRevision);
        if (removed !== undefined) return { status: "deleted" as const };

        const existing = database
          .prepare("SELECT id FROM integrations WHERE id = ?")
          .get(input.integrationId);
        return existing === undefined
          ? { status: "not_found" as const }
          : { status: "no_longer_owned" as const };
      }),
    createOAuthAuthorizationAttempt: (input) =>
      store.write((database) => {
        const now = Date.now();
        database
          .prepare(
            `UPDATE integrations
             SET refresh_state = 'reauthorization_required', refresh_claim_id = NULL,
                 refresh_claimed_at = NULL, updated_at = ?
             WHERE refresh_state = 'refreshing' AND refresh_claim_id IN (
               SELECT state_hash FROM oauth_authorization_attempts
               WHERE mode = 'reconnect' AND status = 'processing' AND expires_at <= ?
             )`
          )
          .run(now, now);
        database
          .prepare(
            "DELETE FROM oauth_authorization_attempts WHERE expires_at <= ?"
          )
          .run(now);
        database
          .prepare(
            `INSERT INTO oauth_authorization_attempts
             (state_hash, integration_id, expires_at, browser_binding_hash, encrypted_payload,
              mode, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
          )
          .run(
            input.stateHash,
            input.integrationId,
            input.expiresAt.getTime(),
            input.browserBindingHash,
            cipher.seal({ payload: JSON.stringify(input.payload) }),
            input.payload.kind,
            now,
            now
          );
      }),
    claimOAuthAuthorizationAttempt: (input) =>
      store
        .write((database) => {
          const now = Date.now();
          const row = database
            .prepare(
              `UPDATE oauth_authorization_attempts
               SET status = CASE WHEN browser_binding_hash = ? THEN 'processing' ELSE 'failed' END,
                   expires_at = ?,
                   updated_at = ?
               WHERE state_hash = ? AND status = 'pending' AND expires_at > ?
               RETURNING integration_id, browser_binding_hash, encrypted_payload`
            )
            .get(
              input.browserBindingHash,
              input.expiresAt.getTime(),
              now,
              input.stateHash,
              now
            );
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
        .pipe(
          Effect.flatMap((attempt) => {
            if (!attempt) {
              return Effect.succeed(null);
            }

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
      store.read((database) => {
        const row = database
          .prepare(
            `SELECT status, result_integration_id
             FROM oauth_authorization_attempts
             WHERE state_hash = ? AND browser_binding_hash = ? AND expires_at > ?`
          )
          .get(input.stateHash, input.browserBindingHash, Date.now());
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
        throw new Error("Invalid SQLite OAuth authorization attempt status");
      }),
    failOAuthAuthorizationAttempt: (input) =>
      store.write(
        (database) =>
          database
            .prepare(
              `UPDATE oauth_authorization_attempts
               SET status = 'failed', expires_at = ?, updated_at = ?
               WHERE state_hash = ? AND status = 'processing'
               RETURNING state_hash`
            )
            .get(input.expiresAt.getTime(), Date.now(), input.stateHash) !==
          undefined
      ),
    completeOAuthCreateAttempt: (input) =>
      store.write((database) => {
        const claim = database
          .prepare(
            `SELECT state_hash FROM oauth_authorization_attempts
             WHERE state_hash = ? AND mode = 'create' AND status = 'processing'`
          )
          .get(input.stateHash);
        if (!claim) return false;

        const now = Date.now();
        database
          .prepare(
            `INSERT INTO integrations
             (id, name, type, config, is_managed, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, ?, ?)`
          )
          .run(
            input.integrationId,
            input.name,
            input.type,
            cipher.seal(input.config),
            now,
            now
          );
        database
          .prepare(
            `UPDATE oauth_authorization_attempts
             SET status = 'succeeded', result_integration_id = ?, expires_at = ?, updated_at = ?
             WHERE state_hash = ? AND mode = 'create' AND status = 'processing'`
          )
          .run(
            input.integrationId,
            input.expiresAt.getTime(),
            now,
            input.stateHash
          );
        return true;
      }),
    completeOAuthReconnectAttempt: (input) =>
      store.write((database) => {
        const attempt = database
          .prepare(
            `SELECT state_hash FROM oauth_authorization_attempts
             WHERE state_hash = ? AND integration_id = ?
               AND mode = 'reconnect' AND status = 'processing'`
          )
          .get(input.stateHash, input.integrationId);
        if (!attempt) return false;

        const now = Date.now();
        const integration = database
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
            now,
            input.integrationId,
            input.stateHash,
            input.expectedRevision
          );
        if (!integration) return false;
        database
          .prepare(
            `UPDATE oauth_authorization_attempts
             SET status = 'succeeded', result_integration_id = ?, expires_at = ?, updated_at = ?
             WHERE state_hash = ? AND integration_id = ?
               AND mode = 'reconnect' AND status = 'processing'`
          )
          .run(
            input.integrationId,
            input.expiresAt.getTime(),
            now,
            input.stateHash,
            input.integrationId
          );
        return true;
      }),
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
      store.write((database) => {
        const transitioned =
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
            ) !== undefined;
        return transitioned
          ? { status: "transitioned" as const }
          : { status: "no_longer_owned" as const };
      }),
  };
}
