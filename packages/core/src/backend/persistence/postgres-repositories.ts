import { Layer } from "effect";
import type { DatabaseSurface } from "#src/backend/lib/db/index";
import { makeDatabaseLayer } from "#src/backend/lib/effect/database";
import { ApiKeyRepoLayer } from "#src/backend/services/api-keys/repo";
import type { IntegrationCipher } from "#src/backend/services/integrations/cipher";
import { makeIntegrationRepoLayer } from "#src/backend/services/integrations/repo";
import { ExecutionRepoLayer } from "#src/backend/services/executions/repo";
import { WorkflowRepoLayer } from "#src/backend/services/workflows/repo/index";
import type { WfGraphRepositories } from "#src/backend/runtime";

/** The PostgreSQL implementation of every repository contract. */
export function makePostgresRepositories(
  database: DatabaseSurface,
  cipher: IntegrationCipher
): Layer.Layer<WfGraphRepositories> {
  const databaseLayer = makeDatabaseLayer(database.db);

  return Layer.mergeAll(
    Layer.provide(ApiKeyRepoLayer, databaseLayer),
    Layer.provide(makeIntegrationRepoLayer(cipher), databaseLayer),
    Layer.provide(
      Layer.mergeAll(WorkflowRepoLayer, ExecutionRepoLayer),
      databaseLayer
    )
  );
}
