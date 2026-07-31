import { Effect, Layer, ManagedRuntime } from "effect";
import {
  AppLogger,
  type EffectLogger,
  type LogProperties,
} from "#src/backend/lib/effect/app-logger";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import {
  Extensions,
  makeExtensionsLayer,
} from "#src/backend/lib/effect/extensions";
import { InngestFunctions } from "#src/backend/lib/effect/inngest-functions";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import type { StepEnvironment } from "#src/backend/extensions/steps/step-runner";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "@rova/shared/extensions/catalog";
import { ApiKeyRepo } from "#src/backend/services/api-keys/repo";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import type { RovaServices } from "#src/backend/runtime";

/**
 * The Layers a backend test stands on.
 *
 * Test support rather than product code: nothing under `src` ships, because
 * `packages/core/package.json` publishes `dist` and `drizzle` and tsdown only
 * bundles what an entry reaches, so this module is unreachable from all four
 * published surfaces.
 *
 * A service test replaces the database at the repository boundary, which means
 * every test naming one method of a repository also had to name the eleven it
 * does not use. That enumeration is what lives here now, so a method added to a
 * repository is one edit rather than six, and the six test files say only what
 * their subject actually asks for.
 */

/**
 * One method that answers nothing.
 *
 * `Effect.die` never returns, so this satisfies any method signature whatever
 * the repository declares, which is what lets the tables below be written out
 * once and annotated with the service type. The annotation is what makes each
 * table exhaustive: a method added to a repository fails to compile here until
 * it is listed.
 */
const refuse = (method: string) => (): Effect.Effect<never> =>
  Effect.die(`${method} is not part of this test`);

const silentLogger: EffectLogger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  with: () => silentLogger,
};

/**
 * A logger that writes nothing.
 *
 * It holds no state, so a `layer(...)` block shares one rather than building it
 * per test. A test that reads its own log lines takes `makeRecordingLogger`
 * instead.
 */
export const SilentAppLoggerLayer: Layer.Layer<AppLogger> = Layer.succeed(
  AppLogger,
  { get: () => silentLogger }
);

/** One line a recording logger kept, as the logger's callers wrote it. */
type RecordedLine = { message: string; properties?: LogProperties };

/**
 * A logger keeping the lines one test produced.
 *
 * Where an operator-facing line is half of what is under test, the assertion
 * needs the line rather than the absence of one. Built per test rather than
 * reset between them, so no test can read another's lines.
 *
 * Each level is kept in its own list because a test asserts one whole list at
 * a time: an `error` assertion should not have to account for whatever the
 * same code path narrated at `info` on its way there.
 */
export function makeRecordingLogger(): {
  lines: RecordedLine[];
  infoLines: RecordedLine[];
  warnLines: RecordedLine[];
  debugLines: RecordedLine[];
  logger: EffectLogger;
  layer: Layer.Layer<AppLogger>;
} {
  const lines: RecordedLine[] = [];
  const infoLines: RecordedLine[] = [];
  const warnLines: RecordedLine[] = [];
  const debugLines: RecordedLine[] = [];

  const recorder: EffectLogger = {
    debug: (message, properties) =>
      Effect.sync(() => {
        debugLines.push({ message, properties });
      }),
    info: (message, properties) =>
      Effect.sync(() => {
        infoLines.push({ message, properties });
      }),
    warn: (message, properties) =>
      Effect.sync(() => {
        warnLines.push({ message, properties });
      }),
    error: (message, properties) =>
      Effect.sync(() => {
        lines.push({ message, properties });
      }),
    with: () => recorder,
  };

  return {
    lines,
    infoLines,
    warnLines,
    debugLines,
    logger: recorder,
    layer: Layer.succeed(AppLogger, { get: () => recorder }),
  };
}

/**
 * The assembled surface, for a test whose subject validates against the catalog.
 *
 * Every save checks the Lifecycle Rules against the catalog, so a test of the
 * save paths has to say what the catalog holds. What it does not say is filled
 * in with the empty catalog and three lookups answering nothing: a catalog entry
 * is metadata, and a test that needs a step or a connection test builds the
 * surface itself with `assembleExtensions`.
 */
export function stubExtensions(
  set: Partial<ExtensionSet> = {}
): Layer.Layer<Extensions> {
  return makeExtensionsLayer({
    catalog: emptyExtensionCatalog,
    stepFor: () => undefined,
    connectionTestFor: () => undefined,
    eventByName: () => undefined,
    events: [],
    ...set,
  });
}

/** The same, said as the catalog alone, which is what most subjects read. */
export function stubExtensionCatalog(
  catalog: Partial<ExtensionCatalog> = {}
): Layer.Layer<Extensions> {
  return stubExtensions({ catalog: { ...emptyExtensionCatalog, ...catalog } });
}

/**
 * What the app hands a step definition, for a test that calls one directly.
 *
 * `implement(id)` answers a factory, so this is its argument: the default runs
 * the handler's Effect on Effect's own runtime and answers no credentials, which
 * is what a step belonging to no integration gets in production too.
 */
export function stubStepEnvironment(
  overrides: Partial<StepEnvironment> = {}
): StepEnvironment {
  return {
    credentialsFor: () => Effect.succeed({}),
    ...overrides,
  };
}

const workflowRepoStubs: WorkflowRepo["Service"] = {
  listSummariesNewestFirst: refuse("listSummariesNewestFirst"),
  listIdentities: refuse("listIdentities"),
  findById: refuse("findById"),
  existsById: refuse("existsById"),
  hasWithName: refuse("hasWithName"),
  hasOtherWithName: refuse("hasOtherWithName"),
  listEventSubscribers: refuse("listEventSubscribers"),
  insert: refuse("insert"),
  findPausedById: refuse("findPausedById"),
  setPaused: refuse("setPaused"),
  update: refuse("update"),
  deleteById: refuse("deleteById"),
  findCurrent: refuse("findCurrent"),
  insertCurrent: refuse("insertCurrent"),
};

/**
 * A workflow repository answering only the methods a test hands it.
 *
 * Everything else dies rather than answering, so a service that grows a query
 * the test did not account for fails loudly instead of reading a fake empty
 * result and taking a branch nobody meant to assert.
 */
export function stubWorkflowRepo(
  overrides: Partial<WorkflowRepo["Service"]> = {}
): Layer.Layer<WorkflowRepo> {
  return Layer.succeed(WorkflowRepo, { ...workflowRepoStubs, ...overrides });
}

const executionRepoStubs: ExecutionRepo["Service"] = {
  listByWorkflow: refuse("listByWorkflow"),
  countSuperseded: refuse("countSuperseded"),
  listPage: refuse("listPage"),
  findSummaryById: refuse("findSummaryById"),
  findStatusById: refuse("findStatusById"),
  existsById: refuse("existsById"),
  findWorkflowIdById: refuse("findWorkflowIdById"),
  startForEntity: refuse("startForEntity"),
  insertTerminal: refuse("insertTerminal"),
  markEnqueued: refuse("markEnqueued"),
  markEnqueueFailed: refuse("markEnqueueFailed"),
  markRunning: refuse("markRunning"),
  endInFlight: refuse("endInFlight"),
  requestCancelForEntity: refuse("requestCancelForEntity"),
  findPendingCancel: refuse("findPendingCancel"),
  finishRun: refuse("finishRun"),
  recordAuditEvent: refuse("recordAuditEvent"),
  openNodeLog: refuse("openNodeLog"),
  closeNodeLog: refuse("closeNodeLog"),
  startWait: refuse("startWait"),
  markWaitStatus: refuse("markWaitStatus"),
  cancelWaits: refuse("cancelWaits"),
  listWaitsForEvent: refuse("listWaitsForEvent"),
  findWaitingStateByToken: refuse("findWaitingStateByToken"),
  listWaitingStates: refuse("listWaitingStates"),
  listWaitingStatesForExecutions: refuse("listWaitingStatesForExecutions"),
  listLogs: refuse("listLogs"),
  listNodeStatuses: refuse("listNodeStatuses"),
  listEvents: refuse("listEvents"),
  listWorkflowEvents: refuse("listWorkflowEvents"),
  deleteAllForWorkflow: refuse("deleteAllForWorkflow"),
};

export function stubExecutionRepo(
  overrides: Partial<ExecutionRepo["Service"]> = {}
): Layer.Layer<ExecutionRepo> {
  return Layer.succeed(ExecutionRepo, { ...executionRepoStubs, ...overrides });
}

const apiKeyRepoStubs: ApiKeyRepo["Service"] = {
  listNewestFirst: refuse("listNewestFirst"),
  insert: refuse("insert"),
  deleteById: refuse("deleteById"),
  findByPrefix: refuse("findByPrefix"),
  touchLastUsed: refuse("touchLastUsed"),
};

export function stubApiKeyRepo(
  overrides: Partial<ApiKeyRepo["Service"]> = {}
): Layer.Layer<ApiKeyRepo> {
  return Layer.succeed(ApiKeyRepo, { ...apiKeyRepoStubs, ...overrides });
}

const integrationRepoStubs: IntegrationRepo["Service"] = {
  listByType: refuse("listByType"),
  findById: refuse("findById"),
  typesByIds: refuse("typesByIds"),
  insert: refuse("insert"),
  update: refuse("update"),
  deleteById: refuse("deleteById"),
};

export function stubIntegrationRepo(
  overrides: Partial<IntegrationRepo["Service"]> = {}
): Layer.Layer<IntegrationRepo> {
  return Layer.succeed(IntegrationRepo, {
    ...integrationRepoStubs,
    ...overrides,
  });
}

const inngestClientStubs: InngestClient["Service"] = {
  sendRunRequested: refuse("sendRunRequested"),
  sendCancelRequested: refuse("sendCancelRequested"),
  sendWaitSignal: refuse("sendWaitSignal"),
};

export function stubInngestClient(
  overrides: Partial<InngestClient["Service"]> = {}
): Layer.Layer<InngestClient> {
  return Layer.succeed(InngestClient, {
    ...inngestClientStubs,
    ...overrides,
  });
}

/**
 * The registry invalidation, as a no-op a test may replace.
 *
 * The default accepts the call and does nothing, because a write that
 * invalidates and a write that does not are both legitimate; a test that asserts
 * on it hands over its own `invalidate`. The repository stubs die on an
 * unaccounted-for call for the opposite reason: a query nobody named would be
 * answered with a fake empty result.
 */
export function stubInngestFunctions(
  overrides: Partial<InngestFunctions["Service"]> = {}
): Layer.Layer<InngestFunctions> {
  return Layer.succeed(InngestFunctions, {
    invalidate: Effect.void,
    ...overrides,
  });
}

/**
 * A whole `RovaRuntime`, for a test standing up something the app builds from
 * its own.
 *
 * Three things take the runtime rather than a service: the engine's Postgres
 * store, the dispatch port's credential fetch, and the Inngest function
 * registry. Each is a Promise boundary the run engine sits behind, so a test of
 * one has no Effect to provide Layers to and needs the runtime itself.
 *
 * Every repository dies on an unnamed method, the same as the stub Layers do, so
 * a subject that reaches a query the test did not account for fails loudly.
 */
export function stubRovaRuntime(
  overrides: {
    extensions?: Partial<ExtensionSet>;
    workflowRepo?: Partial<WorkflowRepo["Service"]>;
    executionRepo?: Partial<ExecutionRepo["Service"]>;
    integrationRepo?: Partial<IntegrationRepo["Service"]>;
    apiKeyRepo?: Partial<ApiKeyRepo["Service"]>;
    inngestClient?: Partial<InngestClient["Service"]>;
  } = {}
): ManagedRuntime.ManagedRuntime<RovaServices, never> {
  return ManagedRuntime.make(
    Layer.mergeAll(
      SilentAppLoggerLayer,
      stubExtensions(overrides.extensions),
      stubWorkflowRepo(overrides.workflowRepo),
      stubExecutionRepo(overrides.executionRepo),
      stubIntegrationRepo(overrides.integrationRepo),
      stubApiKeyRepo(overrides.apiKeyRepo),
      stubInngestClient(overrides.inngestClient),
      stubInngestFunctions()
    )
  );
}
