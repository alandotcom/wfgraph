import {
  type Inngest,
  type InngestFunction,
  type InngestFunctionReference,
  NonRetriableError,
  referenceFunction,
} from "inngest";
import { Schema } from "effect";
import { omit } from "es-toolkit";
import type { WorkflowActions } from "#src/backend/engine/actions";
import {
  type BranchHandoff,
  branchRunResultSchema,
} from "#src/backend/engine/branch";
import { executionError } from "#src/backend/engine/contracts";
import {
  executeWorkflow,
  executeWorkflowBranch,
  type WorkflowBranchInput,
  type WorkflowExecutionInput,
} from "#src/backend/engine/core";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import type { WorkflowStore } from "#src/backend/engine/store";
import { readJsonObject } from "@wfgraph/shared/types/json";
import { rejectUnknownKeys } from "@wfgraph/shared/types/schema";
import { formatSchemaFailure } from "@wfgraph/shared/types/schema-message";
import {
  INNGEST_META_KEY,
  workflowBranchInputSchema,
  workflowBranchKillRequested,
  workflowBranchRequested,
  workflowExecutionInputSchema,
  workflowRunCancelRequested,
  workflowRunRequested,
} from "#src/backend/lib/inngest/events";
import type { WfGraphRuntime } from "#src/backend/runtime";

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
  sleep: (id: string, durationMs: number) => Promise<void>;
  waitForEvent: (
    id: string,
    options: { event: string; if?: string; timeout: string }
  ) => Promise<unknown>;
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  invoke: (
    id: string,
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
 * The envelope is read at both depths it has been seen at, since which one a
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
 * `data` is what the run arrived on, and a branch hand-off is that same payload
 * with the entry node named, so a branch carries the graph and the identity of
 * the run it belongs to without either being rebuilt.
 */
function createDurableRuntime(input: {
  step: DurableStep;
  attempt: number;
  data: WorkflowExecutionInput;
}): WorkflowExecutionRuntime {
  const { step, attempt, data } = input;

  return {
    sleep: async (stepId, durationMs) => {
      if (durationMs <= 0) {
        return;
      }
      await step.sleep(stepId, durationMs);
    },
    waitForEvent: async (stepId, options) =>
      await step.waitForEvent(stepId, {
        event: options.event,
        if: options.ifExpression,
        timeout:
          options.timeoutMs === undefined
            ? "365d"
            : toDurationString(options.timeoutMs),
      }),
    // Memoization boundary: Inngest stores the result under `stepId`, so work
    // already done in an earlier attempt is replayed instead of repeated.
    run: (stepId, fn) => step.run(stepId, fn),
    startBranch: async (stepId, { entryNodeId, releasedNodeIds }) =>
      readBranchHandoff(
        await step.invoke(stepId, {
          function: workflowBranchTarget,
          data: { ...data, entryNodeId, releasedNodeIds },
        })
      ),
    attempt,
  };
}

/**
 * The trigger carries `workflowExecutionInputSchema`, and Inngest validates
 * against it before calling this handler, so `event.data` arrives parsed. A
 * payload that fails raises `EventValidationError`, which extends
 * `NonRetriableError`: a malformed run fails once instead of spending all four
 * retries re-deserializing the same bad JSON.
 */
async function workflowRunRequestedHandler({
  event,
  step,
  attempt,
  actions,
  store,
  appRuntime,
}: {
  event: { data: typeof workflowExecutionInputSchema.Type };
  actions: WorkflowActions;
  store: WorkflowStore;
  /** The application boundary that runs the whole engine Effect. */
  appRuntime: WfGraphRuntime;
  /** Zero on the first attempt of this body, and one higher on each retry. */
  attempt: number;
  step: DurableStep;
}) {
  const data: WorkflowExecutionInput = event.data;

  // The engine persists nothing and implements nothing on its own: the store
  // and the dispatch port are the app's, built where the function was.
  const result = await appRuntime.runPromise(
    executeWorkflow(
      data,
      createDurableRuntime({ step, attempt, data }),
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
  actions,
  store,
  appRuntime,
}: {
  event: { data: typeof workflowBranchInputSchema.Type };
  actions: WorkflowActions;
  store: WorkflowStore;
  appRuntime: WfGraphRuntime;
  attempt: number;
  step: DurableStep;
}) {
  // The invoke metadata describes the event that started this run, so it is
  // dropped here rather than carried onto whatever branch this one hands off.
  const data: WorkflowBranchInput = omit(event.data, [INNGEST_META_KEY]);

  return await appRuntime.runPromise(
    executeWorkflowBranch(
      data,
      createDurableRuntime({ step, attempt, data }),
      store,
      actions
    )
  );
}

/** What an app hands both functions: where work comes from, where rows go. */
type WorkflowFunctionPorts = {
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
};

/**
 * The count a step is retried under. Inngest re-runs a body to retry one,
 * resuming at the step that failed rather than replaying the graph's work, so
 * this is not 0: without it a single transient fault - a provider 502, a blip
 * writing a step log - ends the node on its first refusal. A run that recorded
 * a terminal status ends non-retriably instead and spends none of these.
 *
 * What is remembered is what a handler put in its own `step.run`, plus the
 * run-log row the engine opens around it. WfGraph wraps no handler body
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
 * registration, and Inngest needs no re-sync. Which graph a run walks is on the
 * event, put there by whoever enqueued it.
 *
 * The Inngest dashboard therefore labels every run alike. The workflow's name
 * reaches a trace through the `wfgraph.workflow.name` attribute the engine's span
 * carries.
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
      })
  );
}

/**
 * One waiting branch of a run, as a durable run of its own (ADR-0011).
 *
 * A second registration rather than a mode of the first, because `cancelOn` is
 * declared per function: a branch is killed where it stands, and the run that
 * started it must not be.
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
      triggers: [{ event: workflowBranchRequested }],
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
      })
  );
}
