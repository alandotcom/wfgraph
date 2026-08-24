import { implement } from "@orpc/server";
import { Effect, Schema, Stream } from "effect";
import type { ServiceFailure } from "#src/backend/lib/effect/failures";
import { getAppLogger } from "#src/backend/lib/logger";
import type { WfGraphServices } from "#src/backend/runtime";
import { postAgentChat } from "#src/backend/services/agent/chat";
import { deleteApiKey } from "#src/backend/services/api-keys/api-key";
import {
  getApiKeys,
  postApiKeys,
} from "#src/backend/services/api-keys/api-keys";
import {
  deleteIntegration,
  getIntegration,
  getIntegrations,
  postIntegrations,
  postIntegrationsTest,
  postIntegrationTest,
  putIntegration,
} from "#src/backend/services/integrations/integrations";
import { postWorkflowExecute } from "#src/backend/services/workflows/lifecycle/manual-start";
import { resumeWaitByToken } from "#src/backend/services/workflows/lifecycle/resume";
import { postExecutionCancel } from "#src/backend/services/executions/cancel";
import { getExecutionEvents } from "#src/backend/services/executions/events";
import { getExecutionLogs } from "#src/backend/services/executions/logs";
import { getExecutionStatus } from "#src/backend/services/executions/status";
import {
  deleteWorkflow,
  getWorkflow,
  patchWorkflow,
} from "#src/backend/services/workflows/workflow";
import { postWorkflowDuplicate } from "#src/backend/services/workflows/duplicate";
import { publishWorkflow } from "#src/backend/services/workflows/publish";
import { getVersionGraph } from "#src/backend/services/workflows/version-graph";
import {
  compareWorkflowVersion,
  getWorkflowVersionHistory,
  restoreWorkflowVersion,
} from "#src/backend/services/workflows/versions";
import {
  deleteWorkflowExecutions,
  getWorkflowExecutions,
} from "#src/backend/services/executions/list";
import { getWorkflowExecutionsGlobal } from "#src/backend/services/executions/global";
import { getWorkflows } from "#src/backend/services/workflows/list";
import { postWorkflowsBulkLifecycle } from "#src/backend/services/workflows/bulk-actions";
import { postWorkflowsCreate } from "#src/backend/services/workflows/create";
import {
  getWorkflowsCurrent,
  postWorkflowsCurrent,
} from "#src/backend/services/workflows/current";
import { rpcContract } from "@wfgraph/shared/rpc/contracts";
import { readAs } from "@wfgraph/shared/types/schema";
import { getErrorMessage } from "@wfgraph/shared/utils";
import type { RpcContext } from "#src/backend/rpc/context";
import { toOrpcError } from "#src/backend/rpc/errors";

const rpcLogger = getAppLogger("rpc");

/**
 * The handler options object oRPC passes as the first argument, narrowed to the
 * one member the failure log needs. `rpcEffectHandler` is generic over every
 * route, so its `args` are `unknown` and the route's own input type is out of
 * reach here; every contract input is an object, and a read recovers that much.
 *
 * One leaf at a time, because this runs on the failure path: a handler options
 * object shaped differently than expected should cost the log line its input
 * summary, not throw a second error on top of the one being reported.
 */
const readAnyObject = readAs(Schema.Record(Schema.String, Schema.Unknown));

function summarizeRpcInput(args: unknown[]): unknown {
  if (args.length === 0) {
    return undefined;
  }

  const handlerArgs = readAnyObject(args[0]);
  const input = handlerArgs ? readAnyObject(handlerArgs.input) : undefined;
  if (!input) {
    return undefined;
  }

  const summary: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const value = Reflect.get(input, key);
    // Nested objects are logged as their key list, which keeps a graph payload
    // or a credential bag out of the log line.
    if (typeof value === "object" && value !== null) {
      summary[key] = `{${Object.keys(value).join(", ")}}`;
    } else {
      summary[key] = value;
    }
  }
  return summary;
}

/**
 * Records why a procedure did not answer.
 *
 * The reason belongs on the request's own record, which the HTTP middleware
 * writes once the status is known, so a refused call costs one line instead of
 * two. A procedure reached outside that middleware has no record to write on,
 * and then this writes its own: a defect that left no trace at all would be a
 * step backwards from the `try` these services used to sit inside.
 */
function recordRpcFailure(
  context: RpcContext,
  level: "warn" | "error",
  summary: string,
  error: Record<string, unknown>
): void {
  if (context.requestEvent) {
    context.requestEvent.set({ error });
    return;
  }

  rpcLogger[level](summary, { error });
}

/**
 * Runs a procedure's Effect on the runtime the request carries, and turns a
 * domain failure into the oRPC error oRPC expects a handler to throw.
 *
 * `Effect.fail` carrying the oRPC error is what makes the promise reject with
 * it: `runPromise` squashes a failure cause down to the error itself, so oRPC
 * catches the same object it would have caught from a `throw`.
 *
 * A defect is left to reject the promise and reach oRPC's own 500, and its
 * reason is recorded on the way past.
 *
 * Generic over the service's failures rather than over the whole union, so the
 * narrowing a service's error channel expresses survives the trip through here.
 */
export function rpcEffectHandler<
  TArgs extends [{ context: RpcContext }, ...unknown[]],
  TOutput,
  TFailure extends ServiceFailure,
>(
  handler: (...args: TArgs) => Effect.Effect<TOutput, TFailure, WfGraphServices>
): (...args: TArgs) => Promise<TOutput> {
  return async (...args) =>
    await args[0].context.runtime.runPromise(
      handler(...args).pipe(
        Effect.tapError((failure) =>
          Effect.sync(() => {
            recordRpcFailure(
              args[0].context,
              "warn",
              `RPC handler returned failure [${failure.kind}]`,
              {
                kind: failure.kind,
                message: failure.payload.error,
                input: summarizeRpcInput(args),
              }
            );
          })
        ),
        Effect.tapDefect((defect) =>
          Effect.sync(() => {
            recordRpcFailure(
              args[0].context,
              "error",
              `RPC handler died: ${getErrorMessage(defect)}`,
              {
                kind: "defect",
                message: getErrorMessage(defect),
                input: summarizeRpcInput(args),
              }
            );
          })
        ),
        Effect.mapError(toOrpcError)
      )
    );
}

/**
 * The same, for a procedure whose output is an event iterator.
 *
 * oRPC takes an async generator, so the Effect is run once to build the stream
 * and the stream is then drained into yields. `Stream.toReadableStream` is the
 * bridge: a `ReadableStream` is async-iterable on Node, and abandoning the
 * `for await` cancels the reader, which is how a browser closing the connection
 * stops the turn.
 *
 * A failure while building the stream becomes an oRPC error the same way a
 * unary handler's does. A failure once the stream is running cannot, because the
 * response has already begun; the stream itself is expected to carry its own
 * bad news as a value.
 */
export function rpcStreamHandler<
  TArgs extends [{ context: RpcContext }, ...unknown[]],
  TOutput,
  TFailure extends ServiceFailure,
>(
  handler: (
    ...args: TArgs
  ) => Effect.Effect<Stream.Stream<TOutput>, TFailure, WfGraphServices>
): (...args: TArgs) => AsyncGenerator<TOutput, void> {
  return async function* (...args) {
    const stream = await args[0].context.runtime.runPromise(
      handler(...args).pipe(
        Effect.tapError((failure) =>
          Effect.sync(() => {
            recordRpcFailure(
              args[0].context,
              "warn",
              `RPC stream handler returned failure [${failure.kind}]`,
              {
                kind: failure.kind,
                message: failure.payload.error,
                input: summarizeRpcInput(args),
              }
            );
          })
        ),
        Effect.mapError(toOrpcError)
      )
    );

    yield* Stream.toReadableStream(stream);
  };
}

// Output schemas exist so the client infers a return type and so the OpenAPI
// document has response bodies to describe. Every handler already returns a value
// the schema was written from, so re-validating it on the way out only costs a
// parse per response. The constraint this buys into: disabling output validation
// also skips the encode half of a transforming schema, so an output schema here
// must stay transform-free. Today every output field is a plain string or
// object; a timestamp codec in an output schema would silently not encode.
const rpc = implement(rpcContract)
  .$context<RpcContext>()
  .$config({ disableOutputValidation: true });

export const rpcRouter = rpc.router({
  agent: {
    chat: rpc.agent.chat.handler(
      rpcStreamHandler(({ input }) =>
        postAgentChat({
          workflowId: input.workflowId,
          messages: input.messages,
          graph: input.graph,
        })
      )
    ),
  },
  apiKey: {
    getAll: rpc.apiKey.getAll.handler(rpcEffectHandler(() => getApiKeys())),
    create: rpc.apiKey.create.handler(
      rpcEffectHandler(({ input }) =>
        postApiKeys({
          name: input.name ?? undefined,
        })
      )
    ),
    delete: rpc.apiKey.delete.handler(
      rpcEffectHandler(({ input }) => deleteApiKey(input.keyId))
    ),
  },
  integration: {
    getAll: rpc.integration.getAll.handler(
      rpcEffectHandler(({ input }) => getIntegrations(input.type))
    ),
    get: rpc.integration.get.handler(
      rpcEffectHandler(({ input }) => getIntegration(input.integrationId))
    ),
    create: rpc.integration.create.handler(
      rpcEffectHandler(({ input }) =>
        postIntegrations({
          name: input.name,
          type: input.type,
          config: input.config,
        })
      )
    ),
    update: rpc.integration.update.handler(
      rpcEffectHandler(({ input }) =>
        putIntegration(input.integrationId, {
          name: input.name,
          config: input.config,
        })
      )
    ),
    delete: rpc.integration.delete.handler(
      rpcEffectHandler(({ input }) => deleteIntegration(input.integrationId))
    ),
    testConnection: rpc.integration.testConnection.handler(
      rpcEffectHandler(({ input }) => postIntegrationTest(input.integrationId))
    ),
    testCredentials: rpc.integration.testCredentials.handler(
      rpcEffectHandler(({ input }) =>
        postIntegrationsTest({
          type: input.type,
          config: input.config,
        })
      )
    ),
  },
  workflow: {
    getAll: rpc.workflow.getAll.handler(rpcEffectHandler(() => getWorkflows())),
    getById: rpc.workflow.getById.handler(
      rpcEffectHandler(({ input }) => getWorkflow(input.workflowId))
    ),
    create: rpc.workflow.create.handler(
      rpcEffectHandler(({ input }) =>
        postWorkflowsCreate({
          name: input.name,
          description: input.description,
          graph: input.graph,
        })
      )
    ),
    update: rpc.workflow.update.handler(
      rpcEffectHandler(({ input }) =>
        patchWorkflow(input.workflowId, {
          name: input.name,
          description: input.description,
          graph: input.graph,
          mode: input.mode,
        })
      )
    ),
    delete: rpc.workflow.delete.handler(
      rpcEffectHandler(({ input }) => deleteWorkflow(input.workflowId))
    ),
    duplicate: rpc.workflow.duplicate.handler(
      rpcEffectHandler(({ input }) => postWorkflowDuplicate(input.workflowId))
    ),
    publish: rpc.workflow.publish.handler(
      rpcEffectHandler(({ input }) =>
        publishWorkflow({
          workflowId: input.workflowId,
          graph: input.graph,
          expectedPublishedVersionId: input.expectedPublishedVersionId,
        })
      )
    ),
    getVersionHistory: rpc.workflow.getVersionHistory.handler(
      rpcEffectHandler(({ input }) => getWorkflowVersionHistory(input))
    ),
    compareVersion: rpc.workflow.compareVersion.handler(
      rpcEffectHandler(({ input }) => compareWorkflowVersion(input))
    ),
    restoreVersion: rpc.workflow.restoreVersion.handler(
      rpcEffectHandler(({ input }) => restoreWorkflowVersion(input))
    ),
    getCurrent: rpc.workflow.getCurrent.handler(
      rpcEffectHandler(() => getWorkflowsCurrent())
    ),
    saveCurrent: rpc.workflow.saveCurrent.handler(
      rpcEffectHandler(({ input }) =>
        postWorkflowsCurrent({
          graph: input.graph,
        })
      )
    ),
    execute: rpc.workflow.execute.handler(
      rpcEffectHandler(({ input }) =>
        postWorkflowExecute(input.workflowId, {
          input: input.input,
          eventName: input.eventName,
        })
      )
    ),
    getExecutions: rpc.workflow.getExecutions.handler(
      rpcEffectHandler(({ input }) =>
        getWorkflowExecutions({
          workflowId: input.workflowId,
          includeSuperseded: input.includeSuperseded === true,
        })
      )
    ),
    getExecutionsGlobal: rpc.workflow.getExecutionsGlobal.handler(
      rpcEffectHandler(({ input }) =>
        getWorkflowExecutionsGlobal({
          workflowIds: input.workflowIds,
          statuses: input.statuses,
          limit: input.limit,
          cursor: input.cursor,
        })
      )
    ),
    bulkLifecycle: rpc.workflow.bulkLifecycle.handler(
      rpcEffectHandler(({ input }) =>
        postWorkflowsBulkLifecycle({
          workflowIds: input.workflowIds,
          action: input.action,
        })
      )
    ),
    deleteExecutions: rpc.workflow.deleteExecutions.handler(
      rpcEffectHandler(({ input }) =>
        deleteWorkflowExecutions(input.workflowId)
      )
    ),
    getExecutionLogs: rpc.workflow.getExecutionLogs.handler(
      rpcEffectHandler(({ input }) => getExecutionLogs(input.executionId))
    ),
    getVersionGraph: rpc.workflow.getVersionGraph.handler(
      rpcEffectHandler(({ input }) => getVersionGraph(input.versionId))
    ),
    getExecutionEvents: rpc.workflow.getExecutionEvents.handler(
      rpcEffectHandler(({ input }) => getExecutionEvents(input.executionId))
    ),
    resumeWait: rpc.workflow.resumeWait.handler(
      rpcEffectHandler(({ input }) =>
        resumeWaitByToken({
          token: input.token,
          body: input.payload ?? {},
          source: "the runs panel",
        })
      )
    ),
    cancelExecution: rpc.workflow.cancelExecution.handler(
      rpcEffectHandler(({ input }) => postExecutionCancel(input.executionId))
    ),
    getExecutionStatus: rpc.workflow.getExecutionStatus.handler(
      rpcEffectHandler(({ input }) => getExecutionStatus(input.executionId))
    ),
  },
});
