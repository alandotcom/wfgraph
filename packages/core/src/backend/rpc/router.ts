import { implement } from "@orpc/server";
import type { Effect } from "effect";
import { z } from "zod";
import type { ServiceFailure } from "#src/backend/lib/effect/failures";
import { getAppLogger } from "#src/backend/lib/logger";
import { type RovaServices, runToServiceResult } from "#src/backend/runtime";
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
import { postWorkflowExecuteResult } from "#src/backend/services/workflow/workflow-execute";
import { postExecutionCancelResult } from "#src/backend/services/workflows/execution-cancel";
import { getExecutionEvents } from "#src/backend/services/workflows/execution-events";
import { getExecutionLogs } from "#src/backend/services/workflows/execution-logs";
import { getExecutionStatus } from "#src/backend/services/workflows/execution-status";
import {
  deleteWorkflow,
  getWorkflow,
  patchWorkflow,
} from "#src/backend/services/workflows/workflow";
import { postWorkflowDuplicate } from "#src/backend/services/workflows/workflow-duplicate";
import {
  deleteWorkflowExecutions,
  getWorkflowExecutions,
} from "#src/backend/services/workflows/workflow-executions";
import { getWorkflowExecutionsGlobal } from "#src/backend/services/workflows/workflow-executions-global";
import { postWorkflowWebhookResult } from "#src/backend/services/workflows/workflow-webhook";
import { getWorkflows } from "#src/backend/services/workflows/workflows";
import { postWorkflowsBulkLifecycleResult } from "#src/backend/services/workflows/workflows-bulk-lifecycle";
import { postWorkflowsCreate } from "#src/backend/services/workflows/workflows-create";
import {
  getWorkflowsCurrent,
  postWorkflowsCurrent,
} from "#src/backend/services/workflows/workflows-current";
import { rpcContract } from "@rova/shared/rpc/contracts";
import type { RpcContext } from "./context";
import { type RpcCompatibleResult, toRpcData } from "./errors";

const rpcLogger = getAppLogger("rpc", "handler");

/**
 * The handler options object oRPC passes as the first argument, narrowed to the
 * one member the failure log needs. `rpcHandler` is generic over every route, so
 * its `args` are `unknown` and the route's own input type is out of reach here;
 * every contract input is an object, and a parse recovers that much.
 */
const rpcHandlerArgsSchema = z.looseObject({
  input: z.looseObject({}).optional().catch(undefined),
});

function summarizeRpcInput(args: unknown[]): unknown {
  if (args.length === 0) {
    return undefined;
  }

  const parsed = rpcHandlerArgsSchema.safeParse(args[0]);
  const input = parsed.success ? parsed.data.input : undefined;
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

function rpcHandler<TArgs extends unknown[], TOutput>(
  handler: (
    ...args: TArgs
  ) => RpcCompatibleResult<TOutput> | Promise<RpcCompatibleResult<TOutput>>
): (...args: TArgs) => Promise<TOutput> {
  return async (...args) => {
    const result = await handler(...args);
    if (!result.ok) {
      rpcLogger.warn(
        `RPC handler returned failure [${result.kind}]: ${JSON.stringify(result.error)}`,
        {
          kind: result.kind,
          error: result.error,
          input: summarizeRpcInput(args),
        }
      );
    }
    return toRpcData(Promise.resolve(result));
  };
}

/**
 * The same handler for a service that has been migrated to Effect.
 *
 * The Effect is run down to a `ServiceResult` on the runtime carried by the
 * request context, then handed to `rpcHandler` above, so a migrated procedure
 * logs the same failure line and answers with the same oRPC code as one that has
 * not been migrated yet. Stage 3b of the Effect migration ends with every
 * procedure here, and `rpcHandler` retiring.
 *
 * Generic over the service's failures rather than over the whole union, so the
 * narrowing `runToServiceResult` produces survives the trip through here.
 */
function rpcEffectHandler<
  TArgs extends [{ context: RpcContext }, ...unknown[]],
  TOutput,
  TFailure extends ServiceFailure,
>(
  handler: (...args: TArgs) => Effect.Effect<TOutput, TFailure, RovaServices>
): (...args: TArgs) => Promise<TOutput> {
  return rpcHandler(
    async (...args: TArgs) =>
      await runToServiceResult(args[0].context.runtime, handler(...args))
  );
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
      rpcHandler(({ input }) =>
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
      rpcHandler(({ input }) => postWorkflowDuplicate(input.workflowId))
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
      rpcHandler(({ input }) =>
        postWorkflowExecuteResult(input.workflowId, {
          input: input.input,
        })
      )
    ),
    triggerWebhook: rpc.workflow.triggerWebhook.handler(
      rpcHandler(({ context, input }) => {
        return postWorkflowWebhookResult({
          workflowId: input.workflowId,
          authHeader: context.headers.get("Authorization"),
          body: input.input ?? {},
          runtime: context.runtime,
        });
      })
    ),
    getExecutions: rpc.workflow.getExecutions.handler(
      rpcEffectHandler(({ input }) => getWorkflowExecutions(input.workflowId))
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
      rpcHandler(({ context, input }) =>
        postWorkflowsBulkLifecycleResult({
          workflowIds: input.workflowIds,
          action: input.action,
          deleteOne: (workflowId) =>
            runToServiceResult(context.runtime, deleteWorkflow(workflowId)),
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
    getExecutionEvents: rpc.workflow.getExecutionEvents.handler(
      rpcEffectHandler(({ input }) => getExecutionEvents(input.executionId))
    ),
    cancelExecution: rpc.workflow.cancelExecution.handler(
      rpcHandler(({ input }) => postExecutionCancelResult(input.executionId))
    ),
    getExecutionStatus: rpc.workflow.getExecutionStatus.handler(
      rpcEffectHandler(({ input }) => getExecutionStatus(input.executionId))
    ),
  },
});
