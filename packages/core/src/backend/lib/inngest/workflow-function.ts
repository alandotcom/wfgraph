import {
  type Inngest,
  type InngestFunction,
  type InngestFunctionReference,
  NonRetriableError,
  referenceFunction,
} from "inngest";
import { Effect, Schema } from "effect";
import type { WorkflowActions } from "#src/backend/engine/actions";
import {
  type BranchHandoff,
  branchRunResultSchema,
} from "#src/backend/engine/branch";
import { executionError } from "#src/backend/engine/contracts";
import {
  executeWorkflow as defaultExecuteWorkflow,
  executeWorkflowBranch as defaultExecuteWorkflowBranch,
  type WorkflowBranchInput,
  type WorkflowExecutionInput,
} from "#src/backend/engine/core";
import type {
  DurableStepRef,
  WorkflowExecutionRuntime,
} from "#src/backend/engine/runtime";
import type { WorkflowStore } from "#src/backend/engine/store";
import { getAppLogger } from "#src/backend/lib/logger";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { readJsonObject } from "@wfgraph/shared/types/json";
import { rejectUnknownKeys } from "@wfgraph/shared/types/schema";
import { formatSchemaFailure } from "@wfgraph/shared/types/schema-message";
import {
  INNGEST_META_KEY,
  workflowBranchInputSchema,
  workflowBranchInvoked,
  workflowBranchKillRequested,
  workflowRunRequestSchema,
  workflowRunCancelRequested,
  workflowRunRequested,
} from "#src/backend/lib/inngest/events";
import type { WfGraphRuntime } from "#src/backend/runtime";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { ExecutionSummary } from "#src/backend/services/executions/repo/contracts";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";

/** The engine entry the run function calls; tests inject a stand-in. */
type ExecuteWorkflow = typeof defaultExecuteWorkflow;
type ExecuteWorkflowBranch = typeof defaultExecuteWorkflowBranch;

function toDurationString(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  return `${seconds}s`;
}

/** The id `workflow-branch` registers under, which is also how it is invoked. */
const WORKFLOW_BRANCH_FUNCTION_ID = "workflow-branch";

/**
 * The branch function as an invoke target, named rather than held.
 *
 * A reference resolves by id at run time, which is what lets `workflow-branch`
 * hand off a Wait behind a Wait to another of itself: holding the function value
 * would be a cycle at construction.
 */
const workflowBranchTarget: InngestFunctionReference.Any = referenceFunction({
  functionId: WORKFLOW_BRANCH_FUNCTION_ID,
});

/**
 * The durability primitives both handlers build their runtime on.
 *
 * Structurally typed rather than taken from the SDK's context, so the shape
 * these handlers depend on is stated in one readable place.
 */
type DurableStep = {
  sleep: (step: DurableStepRef, durationMs: number) => Promise<void>;
  waitForEvent: (
    step: DurableStepRef,
    options: { event: string; if?: string; timeout: string }
  ) => Promise<unknown>;
  run: <T>(step: DurableStepRef, fn: () => Promise<T>) => Promise<T>;
  invoke: (
    step: DurableStepRef,
    options: {
      function: InngestFunctionReference.Any;
      data: typeof workflowBranchInputSchema.Type;
    }
  ) => Promise<unknown>;
};

/**
 * Whether an invoke answered with Inngest's own end-of-run envelope rather than
 * with what the branch returned, which is how a cancelled child resolves.
 *
 * The envelope is read at both depths it has been seen at, because which one a
 * given executor sends is not something the engine should have to know.
 */
function isCancelledInvocation(answer: unknown): boolean {
  const envelope = readJsonObject(answer);
  const meta =
    readJsonObject(envelope?.[INNGEST_META_KEY]) ??
    readJsonObject(readJsonObject(envelope?.data)?.[INNGEST_META_KEY]);

  return meta?.status === "Cancelled";
}

/**
 * The decode of a branch's answer. Strict, like the payload that started it:
 * what comes back becomes the run's own results, and a shape nobody checked
 * would reach the terminal record as a verdict.
 */
const readBranchRunResult = Schema.decodeUnknownResult(branchRunResultSchema, {
  ...rejectUnknownKeys,
  errors: "all",
});

/**
 * Reads a `step.invoke` answer as one of the three ways a branch run ends.
 *
 * A completed child resolves with its own return value and a cancelled one
 * resolves with the envelope above. A child that failed rejects, and that
 * rejection travels up as the failure of the node that handed the branch off.
 */
function readBranchHandoff(answer: unknown): BranchHandoff {
  if (isCancelledInvocation(answer)) {
    return { status: "killed" };
  }

  const decoded = readBranchRunResult(answer);
  if (decoded._tag === "Failure") {
    throw new NonRetriableError(
      `A branch run answered with a shape this run cannot read: ${formatSchemaFailure(decoded.failure.issue)}`
    );
  }

  return { status: "finished", result: decoded.success };
}

/**
 * The engine's durability port over Inngest's step tools.
 *
 * A branch hand-off names the execution and the Wait it starts at. The child
 * reloads the graph from that row, so the invoke payload never carries one.
 */
function createDurableRuntime(input: {
  step: DurableStep;
  attempt: number;
  runId: string;
  data: WorkflowExecutionInput;
}): WorkflowExecutionRuntime {
  const { step, attempt, runId, data } = input;

  // Every port forwards the engine's `{ id, name }` straight through: Inngest's
  // step tools each take a `StepOptionsOrId`, where `id` memoizes and `name` is
  // the label the trace prints.
  return {
    sleep: async (durableStep, durationMs) => {
      if (durationMs <= 0) {
        return;
      }
      await step.sleep(durableStep, durationMs);
    },
    waitForEvent: async (durableStep, options) =>
      await step.waitForEvent(durableStep, {
        event: options.event,
        if: options.ifExpression,
        timeout:
          options.timeoutMs === undefined
            ? "365d"
            : toDurationString(options.timeoutMs),
      }),
    // Memoization boundary: Inngest stores the result under the step's id, so
    // work already done in an earlier attempt is replayed instead of repeated.
    run: (durableStep, fn) => step.run(durableStep, fn),
    startBranch: async (durableStep, { entryNodeId, releasedNodeIds }) =>
      readBranchHandoff(
        await step.invoke(durableStep, {
          function: workflowBranchTarget,
          data: {
            executionId: data.executionId,
            entryNodeId,
            releasedNodeIds: [...releasedNodeIds],
          },
        })
      ),
    attempt,
    runId,
  };
}

/**
 * Writes a record onto the Inngest run the call is made inside. Built from the
 * client where the function is created; a test passes its own.
 */
type RunMetadataWriter = (values: JsonObject) => Promise<void>;

/**
 * The one place the SDK's metadata API is named. `wfgraph` is the kind, which
 * the SDK namespaces to `userland.wfgraph`: the block the run's Metadata tab
 * shows beside Inngest's own `inngest.usage`. `run()` is what scopes it to the
 * whole run rather than to the step that wrote it.
 */
function runMetadataWriter(client: Inngest): RunMetadataWriter {
  return (values) => client.metadata.run().update(values, "wfgraph");
}

/**
 * Names the run in the Inngest UI, which labels every run of every workflow
 * "Workflow run" because they all execute on the one function.
 *
 * Wrapped in a step for two reasons. This body replays from the top after every
 * step and every wait, so an unwrapped write would repeat once per driver call
 * and the SDK says as much. And a write issued from inside a step rides out on
 * that step's own checkpoint instead of costing a REST round trip.
 *
 * The step's display name is the workflow's, so the first row of the trace names
 * the graph the run is about to walk.
 *
 * A refused write is swallowed. Inngest raises a non-2xx as an exception, and a
 * run that did its work has not failed because a label would not attach.
 */
async function writeRunMetadata(input: {
  step: DurableStep;
  write: RunMetadataWriter;
  data: WorkflowExecutionInput | WorkflowBranchInput;
}): Promise<void> {
  const { step, write, data } = input;
  const workflow = data.workflowName ?? data.workflowId;

  await step.run({ id: "run-metadata", name: workflow }, async () => {
    try {
      await write({
        workflow,
        workflowId: data.workflowId,
        executionId: data.executionId,
        runMode: data.runMode ?? "live",
        triggerEvent: data.startEventName ?? null,
        versionId: data.workflowVersionId,
        nodes: data.graph.nodes.length,
        // A branch run walks part of a graph, so the node it entered at is the
        // one fact that tells two branches of the same run apart.
        ...("entryNodeId" in data ? { entryNode: data.entryNodeId } : {}),
      });
    } catch (error) {
      getAppLogger("inngest").warn(
        "Could not attach this run's metadata to Inngest",
        { run: { execution: data.executionId }, error }
      );
    }
    // Memoized values round-trip through JSON, and this step answers nothing.
    return null;
  });
}

function isInFlightStatus(status: ExecutionSummary["status"]): boolean {
  return IN_FLIGHT_EXECUTION_STATUSES.some((inFlight) => inFlight === status);
}

/**
 * Reloads the engine input from the execution row and its pinned published
 * version. The trigger is only an id: a graph or a workflow id on the event
 * is not what this run walks, and a row that has already ended is not walked
 * again.
 *
 * A payload that fails Inngest's schema check raises `EventValidationError`
 * before this runs, which extends `NonRetriableError`: a malformed id fails
 * once instead of spending all four retries re-deserializing the same bad JSON.
 */
async function loadPersistedRunInput(
  appRuntime: WfGraphRuntime,
  executionId: string
): Promise<WorkflowExecutionInput> {
  const { execution, workflow, version } = await appRuntime.runPromise(
    Effect.gen(function* () {
      const executions = yield* ExecutionRepo;
      const workflows = yield* WorkflowRepo;
      const storedExecution = yield* executions.findSummaryById(executionId);
      if (!storedExecution) {
        return { execution: storedExecution, workflow: null, version: null };
      }

      const [storedWorkflow, storedVersion] = yield* Effect.all([
        workflows.findById(storedExecution.workflowId),
        workflows.findVersionById(storedExecution.workflowVersionId),
      ]);
      return {
        execution: storedExecution,
        workflow: storedWorkflow,
        version: storedVersion,
      };
    })
  );
  if (!execution) {
    throw new NonRetriableError(
      "The requested workflow execution does not exist"
    );
  }
  if (!isInFlightStatus(execution.status)) {
    throw new NonRetriableError(
      "The requested workflow execution is no longer in flight"
    );
  }
  if (!workflow || !version || version.workflowId !== execution.workflowId) {
    throw new NonRetriableError(
      "The requested workflow version does not exist"
    );
  }

  return {
    graph: version.graph,
    workflowVersionId: version.id,
    catalogFingerprint: version.catalogFingerprint,
    startPayload: execution.input ?? {},
    requestPayload: execution.input ?? {},
    ...(execution.startEventName
      ? { startEventName: execution.startEventName }
      : {}),
    executionId: execution.id,
    workflowId: execution.workflowId,
    workflowName: workflow.name,
    runMode: execution.runMode,
  };
}

async function workflowRunRequestedHandler({
  event,
  step,
  attempt,
  runId,
  actions,
  store,
  appRuntime,
  executeWorkflow,
  write,
}: {
  event: { data: typeof workflowRunRequestSchema.Type };
  actions: WorkflowActions;
  store: WorkflowStore;
  /** The application boundary that runs the whole engine Effect. */
  appRuntime: WfGraphRuntime;
  /** Zero on the first attempt of this body, and one higher on each retry. */
  attempt: number;
  runId: string;
  step: DurableStep;
  executeWorkflow: ExecuteWorkflow;
  write: RunMetadataWriter;
}) {
  const data = await loadPersistedRunInput(appRuntime, event.data.executionId);

  await writeRunMetadata({ step, write, data });

  // The engine persists nothing and implements nothing on its own: the store
  // and the dispatch port are the app's, built where the function was.
  const result = await appRuntime.runPromise(
    executeWorkflow(
      data,
      createDurableRuntime({ step, attempt, runId, data }),
      store,
      actions
    )
  );
  if (!result.success) {
    // A run that died carries one sentence; a run that finished with failed
    // nodes carries one per node, and naming them is the whole of what Inngest
    // shows for the attempt.
    let message = "Workflow execution failed";
    if (typeof result.error === "string") {
      message = result.error;
    } else {
      const failed = Object.entries(result.results).flatMap(
        ([nodeId, nodeResult]) => {
          const nodeError = executionError(nodeResult);
          return nodeError ? [`${nodeId}: ${nodeError}`] : [];
        }
      );
      if (failed.length > 0) {
        message = failed.join("; ");
      }
    }
    // Both of the engine's exits write the run's terminal row inside a memoized
    // step, so another attempt of this body reads that write back out of the
    // memo and the row keeps the verdict it already has. `finishRun` updates an
    // in-flight row alone, so a corrective write is refused in any case, and a
    // Wait node reached on the way would find `createWaitState` declining to
    // park a terminal run. What a retry can still mend is a step, and Inngest
    // retries one inside the body without ever reaching this line.
    throw new NonRetriableError(message);
  }
  return result;
}

/**
 * One waiting branch, walked as a durable run of its own.
 *
 * A failed node comes back in the answer rather than as a throw, because the run
 * that started this one holds the graph's verdict. What this body throws is an
 * error nothing inside the branch could attribute to a node.
 */
async function workflowBranchRequestedHandler({
  event,
  step,
  attempt,
  runId,
  actions,
  store,
  appRuntime,
  executeWorkflowBranch,
  write,
}: {
  event: { data: typeof workflowBranchInputSchema.Type };
  actions: WorkflowActions;
  store: WorkflowStore;
  appRuntime: WfGraphRuntime;
  attempt: number;
  runId: string;
  step: DurableStep;
  executeWorkflowBranch: ExecuteWorkflowBranch;
  write: RunMetadataWriter;
}) {
  const persisted = await loadPersistedRunInput(
    appRuntime,
    event.data.executionId
  );
  const data: WorkflowBranchInput = {
    ...persisted,
    entryNodeId: event.data.entryNodeId,
    releasedNodeIds: event.data.releasedNodeIds,
  };

  await writeRunMetadata({ step, write, data });

  return await appRuntime.runPromise(
    executeWorkflowBranch(
      data,
      createDurableRuntime({ step, attempt, runId, data }),
      store,
      actions
    )
  );
}

/** What an app hands both functions: where work comes from, where rows go. */
export type WorkflowFunctionPorts = {
  /**
   * Where an action id becomes work, built by the app from its own surface.
   *
   * Called once per invocation of the body rather than once per process: the
   * surface holds an integration's credentials for its own lifetime, and a
   * decrypted secret must not outlive the invocation that read it.
   */
  actions: () => WorkflowActions;
  /** Where a run's rows go, built by the app from its own runtime. */
  store: WorkflowStore;
  /** Runs the engine Effect at the outer Inngest execution boundary. */
  appRuntime: WfGraphRuntime;
  /** The engine entry for a full run. */
  executeWorkflow: ExecuteWorkflow;
  /** The engine entry for one waiting branch. */
  executeWorkflowBranch: ExecuteWorkflowBranch;
};

/**
 * The count a step is retried under. Inngest re-runs a body to retry one,
 * resuming at the step that failed rather than replaying the graph's work, so
 * this is not 0: without it a single transient fault - a provider 502, a blip
 * writing a step log - ends the node on its first refusal. A run that recorded
 * a terminal status ends non-retriably instead and spends none of these.
 *
 * What is remembered is what a handler put in its own `step.run`, plus the
 * run-log row the engine opens around it. Workflow Graph wraps no handler body
 * (ADR-0009), so a handler that wraps nothing repeats its work on every
 * attempt.
 *
 * The residual risk is a non-idempotent step that fails *after* its side
 * effect landed (a send that times out waiting for the response): the retry
 * sends again. Steps that must not double-fire should pass an idempotency key
 * to their provider rather than rely on this count.
 */
const STEP_RETRIES = 4;

/**
 * Every run in the app, on one function.
 *
 * The trigger carries no per-workflow filter, so which workflows exist is a
 * question this function never asks: one saved a moment ago runs on the same
 * registration, and Inngest needs no re-sync. Which graph a run walks is
 * reloaded from the pinned published version of the execution id on the event.
 *
 * The Inngest dashboard therefore labels every run alike, and what tells two
 * runs apart is written by the run itself: `userland.wfgraph` metadata on its
 * Metadata tab, plus the `wfgraph.workflow.name` attribute the engine's span
 * carries. Metadata is readable per run and queryable from Insights, and it is
 * not a runs-list filter; searching the list for one workflow still means a CEL
 * expression over `event.data.executionId`.
 *
 * The return type is stated because declaration emit cannot name the inferred
 * one: it references types inngest keeps internal (`SendSignalResponse` under
 * inngest/api). `InngestFunction.Any` is what the served function list collects
 * these into anyway.
 */
export function createWorkflowRunFunction(
  client: Inngest,
  input: WorkflowFunctionPorts
): InngestFunction.Any {
  return client.createFunction(
    {
      id: "workflow-run",
      name: "Workflow run",
      retries: STEP_RETRIES,
      triggers: [{ event: workflowRunRequested }],
      // The branch-kill event is deliberately absent: this run is what closes
      // the rows its killed branches left open and what routes the Execution
      // into its Canceled outlet, so it has to survive what kills them.
      cancelOn: [
        {
          event: workflowRunCancelRequested,
          if: "async.data.executionId == event.data.executionId",
        },
      ],
    },
    async (context) =>
      await workflowRunRequestedHandler({
        ...context,
        actions: input.actions(),
        store: input.store,
        appRuntime: input.appRuntime,
        executeWorkflow: input.executeWorkflow,
        write: runMetadataWriter(client),
      })
  );
}

/**
 * One waiting branch of a run, as a durable run of its own (ADR-0011).
 *
 * A second registration rather than a mode of the first, because `cancelOn` is
 * declared per function: a branch is killed where it stands, and the run that
 * started it must not be. It is invoke-only: a public `workflow/branch.requested`
 * event is not a trigger, and the invoke payload names the execution rather
 * than carrying a graph.
 *
 * Both ways a run ends reach it. A Cancel Event kills the branches and leaves
 * the parent to route the Execution; a policy cancel kills the parent, and this
 * carries it too so a branch is never left working for a run that has ended.
 */
export function createWorkflowBranchFunction(
  client: Inngest,
  input: WorkflowFunctionPorts
): InngestFunction.Any {
  return client.createFunction(
    {
      id: WORKFLOW_BRANCH_FUNCTION_ID,
      name: "Workflow branch",
      retries: STEP_RETRIES,
      triggers: [workflowBranchInvoked],
      cancelOn: [
        {
          event: workflowBranchKillRequested,
          if: "async.data.executionId == event.data.executionId",
        },
        {
          event: workflowRunCancelRequested,
          if: "async.data.executionId == event.data.executionId",
        },
      ],
    },
    async (context) =>
      await workflowBranchRequestedHandler({
        ...context,
        actions: input.actions(),
        store: input.store,
        appRuntime: input.appRuntime,
        executeWorkflowBranch: input.executeWorkflowBranch,
        write: runMetadataWriter(client),
      })
  );
}
