import { Layer, ManagedRuntime } from "effect";
import { AppLogger, AppLoggerLayer } from "#src/backend/lib/effect/app-logger";
import { DatabaseLayer } from "#src/backend/lib/effect/database";
import {
  InngestClient,
  makeInngestClientLayer,
} from "#src/backend/lib/effect/inngest-client";
import {
  InngestFunctions,
  makeInngestFunctionsLayer,
} from "#src/backend/lib/effect/inngest-functions";
import type { InngestSurface } from "#src/backend/lib/inngest/client";
import {
  ApiKeyRepo,
  ApiKeyRepoLayer,
} from "#src/backend/services/api-keys/repo";
import {
  IntegrationRepo,
  IntegrationRepoLayer,
} from "#src/backend/services/integrations/repo";
import {
  ExecutionRepo,
  ExecutionRepoLayer,
} from "#src/backend/services/workflows/executions/repo";
import {
  WorkflowRepo,
  WorkflowRepoLayer,
} from "#src/backend/services/workflows/repo";

/**
 * Everything a service may ask for.
 *
 * `Database` is deliberately absent. A repository is the only thing allowed to
 * run a query, and leaving `Database` out of this union is what enforces that:
 * a service body that writes `yield* Database` puts `Database` in its own `R`,
 * which no longer matches the `R` this runtime satisfies, so the procedure that
 * runs it stops compiling.
 */
export type RovaServices =
  | AppLogger
  | ApiKeyRepo
  | IntegrationRepo
  | WorkflowRepo
  | ExecutionRepo
  | InngestClient
  | InngestFunctions;

// A repository that writes its own Drizzle is composed against the database
// here, so the graph reads as a list of subsystems rather than one nested
// expression. `DatabaseLayer` is named rather than rebuilt per domain: Layers
// are memoized by reference, so one value used in every position means one
// database service, however many domains provide it to. The integration
// repository delegates to `backend/lib/db/integrations`, which holds its own
// handle, so it stands on its own until stage 7 moves that module onto this
// Layer.
const ApiKeysLayer = Layer.provide(ApiKeyRepoLayer, DatabaseLayer);

const WorkflowsLayer = Layer.provide(
  Layer.mergeAll(WorkflowRepoLayer, ExecutionRepoLayer),
  DatabaseLayer
);

function buildRovaLayer(inngest: InngestSurface): Layer.Layer<RovaServices> {
  return Layer.mergeAll(
    AppLoggerLayer,
    ApiKeysLayer,
    IntegrationRepoLayer,
    WorkflowsLayer,
    makeInngestClientLayer(inngest.client),
    makeInngestFunctionsLayer(inngest)
  );
}

/**
 * The Layer graph, built once and owned by the app that created it.
 *
 * `createRovaApp` makes one of these and disposes it. Ownership is what buys the
 * dependency injection: a service reaches its repository and its logger through
 * this graph, so a test swaps either one by handing over a different Layer
 * instead of stubbing a module. Construction is lazy, and the graph is built on
 * the first Effect the runtime runs, so making an app opens no connections.
 *
 * One Rova per process stays the only supported arrangement (ADR-0002).
 */
export type RovaRuntime = ManagedRuntime.ManagedRuntime<RovaServices, never>;

export function createRovaRuntime(inngest: InngestSurface): RovaRuntime {
  return ManagedRuntime.make(buildRovaLayer(inngest));
}
