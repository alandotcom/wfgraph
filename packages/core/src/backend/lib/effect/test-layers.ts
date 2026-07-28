import { Effect, Layer } from "effect";
import {
  AppLogger,
  type EffectLogger,
  type LogProperties,
} from "#src/backend/lib/effect/app-logger";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import { ApiKeyRepo } from "#src/backend/services/api-keys/repo";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { ExecutionRepo } from "#src/backend/services/workflows/executions/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";

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
 * The two levels are kept in separate lists because a test asserts one whole
 * list at a time: an `error` assertion should not have to account for whatever
 * the same code path narrated at `info` on its way there.
 */
export function makeRecordingLogger(): {
  lines: RecordedLine[];
  infoLines: RecordedLine[];
  logger: EffectLogger;
  layer: Layer.Layer<AppLogger>;
} {
  const lines: RecordedLine[] = [];
  const infoLines: RecordedLine[] = [];

  const recorder: EffectLogger = {
    debug: () => Effect.void,
    info: (message, properties) =>
      Effect.sync(() => {
        infoLines.push({ message, properties });
      }),
    warn: () => Effect.void,
    error: (message, properties) =>
      Effect.sync(() => {
        lines.push({ message, properties });
      }),
    with: () => recorder,
  };

  return {
    lines,
    infoLines,
    logger: recorder,
    layer: Layer.succeed(AppLogger, { get: () => recorder }),
  };
}

const workflowRepoStubs: WorkflowRepo["Service"] = {
  listNewestFirst: refuse("listNewestFirst"),
  findById: refuse("findById"),
  existsById: refuse("existsById"),
  hasWithName: refuse("hasWithName"),
  hasOtherWithName: refuse("hasOtherWithName"),
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
  listPage: refuse("listPage"),
  findSummaryById: refuse("findSummaryById"),
  findStatusById: refuse("findStatusById"),
  existsById: refuse("existsById"),
  findWorkflowIdById: refuse("findWorkflowIdById"),
  insertRunning: refuse("insertRunning"),
  insertTerminal: refuse("insertTerminal"),
  setRunId: refuse("setRunId"),
  markEnqueueFailed: refuse("markEnqueueFailed"),
  findWaitingStateByToken: refuse("findWaitingStateByToken"),
  listLogs: refuse("listLogs"),
  listNodeStatuses: refuse("listNodeStatuses"),
  listEvents: refuse("listEvents"),
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
