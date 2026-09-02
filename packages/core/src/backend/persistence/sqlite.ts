import { Layer } from "effect";
import { ApiKeyRepo } from "#src/backend/services/api-keys/repo";
import type { IntegrationCipher } from "#src/backend/services/integrations/cipher";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { WfGraphPersistence } from "#src/backend/persistence/types";
import { openSqliteDatabase } from "#src/backend/persistence/sqlite/database";
import { makeSqliteApiKeyRepo } from "#src/backend/persistence/sqlite/api-keys";
import { makeSqliteIntegrationRepo } from "#src/backend/persistence/sqlite/integrations";
import { makeSqliteWorkflowRepo } from "#src/backend/persistence/sqlite/workflows";
import { makeSqliteExecutionRepo } from "#src/backend/persistence/sqlite/executions/index";

export type SqlitePersistenceOptions = {
  /** A filesystem path. Omit for an in-memory database. */
  filename?: string;
  /** How long a writer waits for another process's transaction. Defaults to 5s. */
  busyTimeoutMs?: number;
};

export function wfSqlite(
  options: SqlitePersistenceOptions = {}
): WfGraphPersistence {
  const filename = options.filename ?? ":memory:";
  if (!filename) {
    throw new Error("wfSqlite filename cannot be empty");
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new Error("wfSqlite busyTimeoutMs must be a non-negative integer");
  }

  return {
    open: async (cipher: IntegrationCipher) => {
      const database = await openSqliteDatabase({
        filename,
        busyTimeoutMs,
      });
      return {
        repositories: Layer.mergeAll(
          Layer.succeed(ApiKeyRepo, makeSqliteApiKeyRepo(database)),
          Layer.succeed(
            IntegrationRepo,
            makeSqliteIntegrationRepo(database, cipher)
          ),
          Layer.succeed(WorkflowRepo, makeSqliteWorkflowRepo(database)),
          Layer.succeed(ExecutionRepo, makeSqliteExecutionRepo(database))
        ),
        description: { backend: "sqlite", filename },
        close: database.close,
      };
    },
  };
}
