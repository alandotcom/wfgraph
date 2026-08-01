import { drizzle } from "drizzle-orm/pg-proxy";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { RovaDatabase } from "#src/backend/lib/db/index";
import * as schema from "#src/backend/lib/db/schema";
import {
  AppLogger,
  type EffectLogger,
  type LogProperties,
} from "#src/backend/lib/effect/app-logger";
import { Database } from "#src/backend/lib/effect/database";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import {
  Extensions,
  makeExtensionsLayer,
} from "#src/backend/lib/effect/extensions";
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
 * `implement(id)` answers a factory, so this is its argument. The defaults
 * answer no credentials, which is what a step belonging to no integration gets
 * in production too, and run the step on Effect's own runtime, which is the
 * whole of what a step needs when nothing it reaches is an app service.
 */
export function stubStepEnvironment(
  overrides: Partial<StepEnvironment> = {}
): StepEnvironment {
  return {
    credentialsFor: () => Effect.succeed({}),
    runStep: (effect) => Effect.runPromise(effect),
    ...overrides,
  };
}

/** One statement the query builder sent, as the driver received it. */
export type CapturedStatement = { query: string; params: unknown[] };

/** What a statement answers with: one array per row, in the order it selects. */
export type StatementRows = unknown[][];

export type StubbedDatabase = {
  /** For a repository built from the service value, as `makeRunsMethods` is. */
  readonly service: Database["Service"];
  /** For a repository reached through a Layer, as `WorkflowRepoLayer` is. */
  readonly layer: Layer.Layer<Database>;
  /** Every statement sent, in the order the repository sent them. */
  readonly statements: CapturedStatement[];
};

/**
 * The database as the statements a repository sends, with no database behind it.
 *
 * This is the seam below the repository stubs above: those replace a repository
 * for a service test, this replaces the connection for a repository's own test.
 * A guard living in a `WHERE` is invisible to every caller, since each of them
 * stubs the repository whole, so the statement itself has to be the assertion.
 *
 * `drizzle-orm/pg-proxy` runs the real query builder and hands each statement to
 * `answer` rather than to a connection. The proxy driver has no transactions, so
 * the handle answers `transaction` by running the body against itself; a method
 * that opens one is then testable without the rollback a real one would give.
 */
export function stubDatabase(
  answer: (statement: CapturedStatement) => StatementRows = () => []
): StubbedDatabase {
  const statements: CapturedStatement[] = [];

  const base = drizzle(
    async (query, params) => {
      const statement = { query, params };
      statements.push(statement);
      return { rows: answer(statement) };
    },
    { schema }
  );

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the two handles differ only in the driver behind them: both are Drizzle over `schema`, so every method a repository reaches for is present and builds the same statement. This is the one place the two are equated, which is what this factory exists to be.
  const db: RovaDatabase = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return async (body: (tx: unknown) => Promise<unknown>) => body(db);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as RovaDatabase;

  const service: Database["Service"] = {
    query: (run) => Effect.promise(() => run(db)),
  };

  return { service, layer: Layer.succeed(Database, service), statements };
}

const workflowRepoStubs: WorkflowRepo["Service"] = {
  listSummariesNewestFirst: refuse("listSummariesNewestFirst")(),
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
  findCurrent: refuse("findCurrent")(),
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
  listNewestFirst: refuse("listNewestFirst")(),
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
 * A whole `RovaRuntime`, for a test standing up something the app builds from
 * its own.
 *
 * Three things take the runtime rather than a service: the engine's Postgres
 * store, the dispatch port's credential fetch, and the Inngest function list.
 * Each is a Promise boundary the run engine sits behind, so a test of one has no
 * Effect to provide Layers to and needs the runtime itself.
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
      stubInngestClient(overrides.inngestClient)
    )
  );
}
