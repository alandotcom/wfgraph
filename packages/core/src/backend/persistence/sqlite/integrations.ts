import { Effect } from "effect";
import { generateId } from "@wfgraph/shared/utils/id";
import type {
  EncryptionKeyMismatch,
  IntegrationCipher,
} from "#src/backend/services/integrations/cipher";
import {
  IntegrationRepo,
  type DecryptedIntegration,
} from "#src/backend/services/integrations/repo";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import {
  optionalBoolean,
  placeholders,
  requiredDate,
  requiredString,
} from "#src/backend/persistence/sqlite/database";

const INTEGRATION_COLUMNS =
  "id, name, type, config, is_managed, created_at, updated_at";

type StoredIntegration = Omit<DecryptedIntegration, "config"> & {
  config: string;
};

function storedIntegration(row: Record<string, unknown>): StoredIntegration {
  return {
    id: requiredString(row, "id"),
    name: requiredString(row, "name"),
    type: requiredString(row, "type"),
    config: requiredString(row, "config"),
    isManaged: optionalBoolean(row, "is_managed"),
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
          isManaged: false,
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
          if (!current) return null;
          const row = storedIntegration(current);
          const updatedAt = new Date();
          const config =
            updates.config === undefined
              ? row.config
              : cipher.seal(updates.config);
          const name = updates.name ?? row.name;
          database
            .prepare(
              `UPDATE integrations SET name = ?, config = ?, updated_at = ?
               WHERE id = ?`
            )
            .run(name, config, updatedAt.getTime(), integrationId);
          return { ...row, name, config, updatedAt };
        })
        .pipe(Effect.flatMap(decryptOptional)),
    deleteById: (integrationId) =>
      store.write(
        (database) =>
          database
            .prepare("DELETE FROM integrations WHERE id = ? RETURNING id")
            .get(integrationId) !== undefined
      ),
  };
}
