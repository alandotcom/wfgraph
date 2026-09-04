import {
  AsyncIteratorClass,
  implement,
  ORPCError,
  withEventMeta,
} from "@orpc/server";
import { Cause, Effect, Exit, Fiber, Schema, Stream } from "effect";
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
import { postIntegrationConfigOptions } from "#src/backend/services/integrations/config-options";
import { deleteIntegrationOAuth } from "#src/backend/services/integrations/oauth";
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
  streamWorkflowDraftRevisions,
} from "#src/backend/services/workflows/workflow";
import { postWorkflowDuplicate } from "#src/backend/services/workflows/duplicate";
import { publishWorkflow } from "#src/backend/services/workflows/publish";
import { getVersionGraph } from "#src/backend/services/workflows/version-graph";
import {
  compareWorkflowVersion,
  getWorkflowVersionHistory,
  getWorkflowVersionUsage,
  restoreWorkflowVersion,
} from "#src/backend/services/workflows/versions";
import {
  deleteWorkflowExecutions,
  getWorkflowExecutions,
} from "#src/backend/services/executions/list";
import { getWorkflowExecutionsGlobal } from "#src/backend/services/executions/global";
import {
  getWorkflows,
  streamWorkflowSummaries,
} from "#src/backend/services/workflows/list";
import { postWorkflowsBulkLifecycle } from "#src/backend/services/workflows/bulk-actions";
import { postWorkflowsCreate } from "#src/backend/services/workflows/create";
import {
  getWorkflowsCurrent,
  postWorkflowsCurrent,
} from "#src/backend/services/workflows/current";
import {
  getWfGraphOperation,
  rpcContract,
} from "@wfgraph/shared/rpc/contracts";
import { FORBIDDEN_BODY } from "#src/backend/lib/http/authorize";
import { readAs } from "@wfgraph/shared/types/schema";
import { getErrorMessage } from "@wfgraph/shared/utils";
import type { RpcContext } from "#src/backend/rpc/context";
import { toOrpcError } from "#src/backend/rpc/errors";

const rpcLogger = getAppLogger("rpc");

/**
 * The handler options object oRPC passes as the first argument, narrowed to the
 * one member the failure log needs. `rpcEffectHandler` is generic over every
 * route, so its handler arguments are `unknown` and the route's own input type
 * is out of reach here; every contract input is an object, and a read recovers
 * that much.
 *
 * One leaf at a time, because this runs on the failure path: a handler options
 * object shaped differently than expected should cost the log line its input
 * summary, not throw a second error on top of the one being reported.
 */
const readAnyObject = readAs(Schema.Record(Schema.String, Schema.Unknown));

function summarizeRpcInput(handlerArgs: unknown[]): unknown {
  if (handlerArgs.length === 0) {
    return undefined;
  }

  const handlerOptions = readAnyObject(handlerArgs[0]);
  const input = handlerOptions
    ? readAnyObject(handlerOptions.input)
    : undefined;
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

type PendingStreamNext<T> = {
  resolve: (result: IteratorResult<T, void>) => void;
  reject: (error: unknown) => void;
};

type PendingStreamValue<T> = {
  value: T;
  resume: (effect: Effect.Effect<void>) => void;
};

type StreamTerminal =
  | { readonly _tag: "End" }
  | { readonly _tag: "Error"; readonly error: unknown };

/**
 * Passes one value at a time from an Effect stream to an async iterator.
 * The producer waits until the iterator consumes each value. Cancellation
 * settles a waiting `next()` before the caller waits for Effect finalizers.
 */
class RpcStreamMailbox<T> {
  private cancelled = false;
  private pendingNext: PendingStreamNext<T> | undefined;
  private pendingValue: PendingStreamValue<T> | undefined;
  private terminal: StreamTerminal | undefined;

  readonly offer = (value: T): Effect.Effect<void> =>
    Effect.callback<void>((resume) => {
      if (this.cancelled) {
        resume(Effect.interrupt);
        return Effect.void;
      }

      const pendingNext = this.pendingNext;
      if (pendingNext) {
        this.pendingNext = undefined;
        pendingNext.resolve({ done: false, value });
        resume(Effect.void);
        return Effect.void;
      }

      const pendingValue = { value, resume };
      this.pendingValue = pendingValue;
      return Effect.sync(() => {
        if (this.pendingValue === pendingValue) {
          this.pendingValue = undefined;
        }
      });
    });

  readonly next = (): Promise<IteratorResult<T, void>> => {
    if (this.cancelled) {
      return Promise.resolve({ done: true, value: undefined });
    }

    const pendingValue = this.pendingValue;
    if (pendingValue) {
      this.pendingValue = undefined;
      pendingValue.resume(Effect.void);
      return Promise.resolve({ done: false, value: pendingValue.value });
    }

    if (this.terminal) {
      return this.terminal._tag === "End"
        ? Promise.resolve({ done: true, value: undefined })
        : Promise.reject(this.terminal.error);
    }

    const pending = Promise.withResolvers<IteratorResult<T, void>>();
    this.pendingNext = pending;
    return pending.promise;
  };

  finish(exit: Exit.Exit<void, unknown>): void {
    // ManagedRuntime reports disposal during first context construction as a
    // "ManagedRuntime disposed" defect instead of an interrupt.
    const terminal: StreamTerminal = Exit.isSuccess(exit)
      ? { _tag: "End" }
      : Cause.hasInterruptsOnly(exit.cause) ||
          Cause.squash(exit.cause) === "ManagedRuntime disposed"
        ? { _tag: "End" }
        : { _tag: "Error", error: Cause.squash(exit.cause) };
    this.terminal = terminal;

    const pendingNext = this.pendingNext;
    if (!pendingNext) {
      return;
    }

    this.pendingNext = undefined;
    if (terminal._tag === "End") {
      pendingNext.resolve({ done: true, value: undefined });
    } else {
      pendingNext.reject(terminal.error);
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.terminal = { _tag: "End" };

    const pendingNext = this.pendingNext;
    this.pendingNext = undefined;
    pendingNext?.resolve({ done: true, value: undefined });

    const pendingValue = this.pendingValue;
    this.pendingValue = undefined;
    pendingValue?.resume(Effect.interrupt);
  }
}

/**
 * Runs a streaming procedure on the runtime carried by its request.
 *
 * The managed runtime owns the producer fiber. The mailbox applies
 * backpressure and lets oRPC interrupt that fiber while `next()` is waiting.
 * A handler construction failure becomes an oRPC error. A running stream sends
 * its own failure event after the response starts.
 */
export function rpcStreamHandler<
  THandlerArgs extends [
    { context: RpcContext; signal?: AbortSignal | undefined },
    ...unknown[],
  ],
  TOutput,
  TFailure extends ServiceFailure,
>(
  handler: (
    ...args: THandlerArgs
  ) => Effect.Effect<
    Stream.Stream<TOutput, TFailure, WfGraphServices>,
    TFailure,
    WfGraphServices
  >
): (...args: THandlerArgs) => AsyncIteratorClass<TOutput, void> {
  return (...args) => {
    const mailbox = new RpcStreamMailbox<TOutput>();
    let fiber: Fiber.Fiber<void, unknown> | undefined;

    const startProducer = (): void => {
      const signal = args[0].signal;
      if (signal?.aborted) {
        mailbox.cancel();
        return;
      }

      fiber = args[0].context.runtime.runFork(
        handler(...args).pipe(
          Effect.flatMap((stream) => Stream.runForEach(stream, mailbox.offer)),
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
        ),
        { signal }
      );
      fiber.addObserver((exit) => mailbox.finish(exit));
    };

    const next = (): Promise<IteratorResult<TOutput, void>> => {
      if (!fiber) {
        startProducer();
      }
      return mailbox.next();
    };

    return new AsyncIteratorClass(next, async () => {
      mailbox.cancel();
      if (fiber) {
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
    });
  };
}

type RpcAuthorizationInput = {
  context: RpcContext;
  procedure: Parameters<typeof getWfGraphOperation>[0];
};

/**
 * Requires an operation declaration before a procedure can reach a business
 * handler. A procedure omitted from the contract authorization map is a server
 * configuration error, so it receives a 500 instead of an implicit grant.
 */
async function authorizeRpcProcedure({
  context,
  procedure,
}: RpcAuthorizationInput): Promise<void> {
  const operation = getWfGraphOperation(procedure);
  if (!operation) {
    throw new ORPCError("INTERNAL_SERVER_ERROR");
  }

  if (!(await context.auth.allows(operation))) {
    throw new ORPCError("FORBIDDEN", { data: FORBIDDEN_BODY });
  }
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
  .$config({ disableOutputValidation: true })
  .use(async ({ context, procedure, next }) => {
    await authorizeRpcProcedure({ context, procedure });
    return await next();
  });

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
    disconnectOAuth: rpc.integration.disconnectOAuth.handler(
      rpcEffectHandler(({ input }) =>
        deleteIntegrationOAuth(input.integrationId)
      )
    ),
    testConnection: rpc.integration.testConnection.handler(
      rpcEffectHandler(({ input }) =>
        postIntegrationTest(input.integrationId, input.config)
      )
    ),
    configOptions: rpc.integration.configOptions.handler(
      rpcEffectHandler(({ input }) =>
        postIntegrationConfigOptions(
          input.integrationId,
          input.provider,
          input.parameters ?? {}
        )
      )
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
    subscribeList: rpc.workflow.subscribeList.handler(
      rpcStreamHandler(() => streamWorkflowSummaries())
    ),
    getById: rpc.workflow.getById.handler(
      rpcEffectHandler(({ input }) => getWorkflow(input.workflowId))
    ),
    subscribeDraft: rpc.workflow.subscribeDraft.handler(
      rpcStreamHandler(({ input, lastEventId }) =>
        streamWorkflowDraftRevisions({
          workflowId: input.workflowId,
          afterDraftRevision: Math.max(
            input.afterDraftRevision,
            Number.isSafeInteger(Number(lastEventId))
              ? Number(lastEventId)
              : input.afterDraftRevision
          ),
        }).pipe(
          Effect.map((stream) =>
            stream.pipe(
              Stream.map((event) =>
                withEventMeta(event, { id: String(event.draftRevision) })
              )
            )
          )
        )
      )
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
          expectedDraftRevision: input.expectedDraftRevision,
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
          expectedDraftRevision: input.expectedDraftRevision,
          expectedPublishedVersionId: input.expectedPublishedVersionId,
        })
      )
    ),
    getVersionHistory: rpc.workflow.getVersionHistory.handler(
      rpcEffectHandler(({ input }) => getWorkflowVersionHistory(input))
    ),
    getVersionUsage: rpc.workflow.getVersionUsage.handler(
      rpcEffectHandler(({ input }) => getWorkflowVersionUsage(input))
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
          expectedDraftRevision: input.expectedDraftRevision,
        })
      )
    ),
    execute: rpc.workflow.execute.handler(
      rpcEffectHandler(({ input }) =>
        postWorkflowExecute(input.workflowId, {
          input: input.input,
          eventName: input.eventName,
          graph: input.graph,
          expected: input.expected,
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
