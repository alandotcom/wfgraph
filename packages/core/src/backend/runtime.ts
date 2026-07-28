import { Effect, Layer, ManagedRuntime } from "effect";
import { AppLogger, AppLoggerLayer } from "#src/backend/lib/effect/app-logger";
import { DatabaseLayer } from "#src/backend/lib/effect/database";
import type {
  ServiceFailure,
  ServiceFailurePayload,
} from "#src/backend/lib/effect/failures";
import {
  failure,
  // The pre-Effect failure type of the same name. It and the rest of
  // `service-result.ts` go away at the end of stage 3b, when the last service
  // returning a `ServiceResult` becomes an Effect.
  type ServiceFailure as LegacyServiceFailure,
  type ServiceResult,
  success,
} from "#src/backend/lib/service-result";
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
 * Everything a migrated service may ask for.
 *
 * `Database` is deliberately absent. A repository is the only thing allowed to
 * run a query, and leaving `Database` out of this union is what enforces that:
 * a service body that writes `yield* Database` puts `Database` in its own `R`,
 * which no longer matches the `R` this runtime satisfies, and the call to
 * `runToServiceResult` stops compiling.
 */
export type RovaServices =
  | AppLogger
  | ApiKeyRepo
  | IntegrationRepo
  | WorkflowRepo
  | ExecutionRepo;

// A repository that writes its own Drizzle is composed against the database
// here, so the graph reads as a list of subsystems rather than one nested
// expression. `DatabaseLayer` is named rather than rebuilt per domain: Layers
// are memoized by reference, so one value used in every position means one
// database service, however many domains provide it to. The integration
// repository delegates to `backend/lib/db/integrations`, which holds its own
// handle, so it stands on its own until stage 3b's finale moves that module onto
// this Layer.
const ApiKeysLayer = Layer.provide(ApiKeyRepoLayer, DatabaseLayer);

const WorkflowsLayer = Layer.provide(
  Layer.mergeAll(WorkflowRepoLayer, ExecutionRepoLayer),
  DatabaseLayer
);

const RovaLayer: Layer.Layer<RovaServices> = Layer.mergeAll(
  AppLoggerLayer,
  ApiKeysLayer,
  IntegrationRepoLayer,
  WorkflowsLayer
);

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

export function createRovaRuntime(): RovaRuntime {
  return ManagedRuntime.make(RovaLayer);
}

/**
 * The seam between Effect and everything that still speaks Promises.
 *
 * A migrated service returns `Effect<A, F, RovaServices>` where `F` is the
 * failures it can actually produce; the handlers, the two edge adapters, and the
 * services yet to migrate all read `ServiceResult`. Running an Effect down to a
 * `ServiceResult` here means `backend/rpc/errors.ts` and
 * `response-from-service-result.ts` keep working unchanged, so a migrated
 * procedure answers with the same oRPC code, the same HTTP status, and the same
 * body as before.
 *
 * The result's kind is `F["kind"]`, not the whole `ServiceFailureKind` union, so
 * a caller switching on the failures of a service that only looks something up
 * has no `conflict` branch to write.
 *
 * A defect is left alone: it rejects the promise and reaches the same
 * unhandled-error path an unexpected throw takes today.
 */
export async function runToServiceResult<A, F extends ServiceFailure>(
  runtime: RovaRuntime,
  effect: Effect.Effect<A, F, RovaServices>
): Promise<ServiceResult<A, F["kind"], ServiceFailurePayload>> {
  return await runtime.runPromise(
    effect.pipe(
      Effect.match({
        onSuccess: (data) => success(data),
        onFailure: (
          serviceFailure
        ): LegacyServiceFailure<F["kind"], ServiceFailurePayload> =>
          failure(serviceFailure.kind, serviceFailure.payload),
      })
    )
  );
}
