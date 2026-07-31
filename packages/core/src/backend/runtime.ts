import { Layer, ManagedRuntime } from "effect";
import type { DatabaseSurface } from "#src/backend/lib/db/index";
import { AppLogger, AppLoggerLayer } from "#src/backend/lib/effect/app-logger";
import { makeDatabaseLayer } from "#src/backend/lib/effect/database";
import {
  Extensions,
  makeExtensionsLayer,
} from "#src/backend/lib/effect/extensions";
import {
  InngestClient,
  makeInngestClientLayer,
} from "#src/backend/lib/effect/inngest-client";
import { TracerBridgeLayer } from "#src/backend/lib/effect/tracer";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import type { InngestSurface } from "#src/backend/lib/inngest/client";
import {
  ApiKeyRepo,
  ApiKeyRepoLayer,
} from "#src/backend/services/api-keys/repo";
import type { IntegrationCipher } from "#src/backend/services/integrations/cipher";
import {
  IntegrationRepo,
  makeIntegrationRepoLayer,
} from "#src/backend/services/integrations/repo";
import {
  ExecutionRepo,
  ExecutionRepoLayer,
} from "#src/backend/services/executions/repo";
import {
  WorkflowRepo,
  WorkflowRepoLayer,
} from "#src/backend/services/workflows/repo";

/**
 * Everything a service may ask for.
 *
 * `Extensions` is the assembled surface, which a service reads for the
 * vocabulary its checks are made against. `Database` is deliberately absent. A
 * repository is the only thing allowed to run a query, and leaving `Database`
 * out of this union is what enforces that:
 * a service body that writes `yield* Database` puts `Database` in its own `R`,
 * which no longer matches the `R` this runtime satisfies, so the procedure that
 * runs it stops compiling.
 */
export type RovaServices =
  | AppLogger
  | Extensions
  | ApiKeyRepo
  | IntegrationRepo
  | WorkflowRepo
  | ExecutionRepo
  | InngestClient;

/** Everything the app hands the Layer graph, as the app itself holds it. */
export type RovaRuntimeParts = {
  inngest: InngestSurface;
  extensions: ExtensionSet;
  database: DatabaseSurface;
  /** The AES envelope an integration's stored config passes through. */
  cipher: IntegrationCipher;
};

// Every repository is composed against the database here, so the graph reads as
// a list of subsystems rather than one nested expression. The database Layer is
// named rather than rebuilt per domain: Layers are memoized by reference, so one
// value used in every position means one database service, however many domains
// provide it to.
function buildRovaLayer(parts: RovaRuntimeParts): Layer.Layer<RovaServices> {
  const database = makeDatabaseLayer(parts.database.db);

  return Layer.mergeAll(
    AppLoggerLayer,
    // Provides no service: it replaces the Tracer every Effect span is opened on.
    TracerBridgeLayer,
    makeExtensionsLayer(parts.extensions),
    Layer.provide(ApiKeyRepoLayer, database),
    Layer.provide(makeIntegrationRepoLayer(parts.cipher), database),
    Layer.provide(
      Layer.mergeAll(WorkflowRepoLayer, ExecutionRepoLayer),
      database
    ),
    makeInngestClientLayer(parts.inngest.client)
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

export function createRovaRuntime(parts: RovaRuntimeParts): RovaRuntime {
  return ManagedRuntime.make(buildRovaLayer(parts));
}
