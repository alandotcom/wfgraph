import { implement } from "@orpc/server";
import { getAppLogger } from "@/backend/lib/logger";
import { deleteApiKeyResult } from "@/backend/services/api-keys/api-key.api-keys";
import {
  getApiKeysResult,
  postApiKeysResult,
} from "@/backend/services/api-keys/api-keys.api-keys";
import {
  deleteIntegrationResult,
  getIntegrationResult,
  getIntegrationsResult,
  postIntegrationsResult,
  postIntegrationsTestResult,
  postIntegrationTestResult,
  putIntegrationResult,
} from "@/backend/services/integrations/integrations.integrations";
import { postWorkflowExecuteResult } from "@/backend/services/workflow/workflow-execute.workflow";
import { postExecutionCancelResult } from "@/backend/services/workflows/execution-cancel.workflows";
import { getExecutionEventsResult } from "@/backend/services/workflows/execution-events.workflows";
import { getExecutionLogsResult } from "@/backend/services/workflows/execution-logs.workflows";
import { getExecutionStatusResult } from "@/backend/services/workflows/execution-status.workflows";
import {
  deleteWorkflow,
  getWorkflow,
  patchWorkflow,
} from "@/backend/services/workflows/workflow.workflows";
import { postWorkflowDuplicate } from "@/backend/services/workflows/workflow-duplicate.workflows";
import {
  deleteWorkflowExecutionsResult,
  getWorkflowExecutionsResult,
} from "@/backend/services/workflows/workflow-executions.workflows";
import { getWorkflowExecutionsGlobalResult } from "@/backend/services/workflows/workflow-executions-global.workflows";
import { postWorkflowWebhookResult } from "@/backend/services/workflows/workflow-webhook.workflows";
import { getWorkflows } from "@/backend/services/workflows/workflows.workflows";
import { postWorkflowsBulkLifecycleResult } from "@/backend/services/workflows/workflows-bulk-lifecycle.workflows";
import { postWorkflowsCreate } from "@/backend/services/workflows/workflows-create.workflows";
import {
  getWorkflowsCurrent,
  postWorkflowsCurrent,
} from "@/backend/services/workflows/workflows-current.workflows";
import { rpcContract } from "@/shared/rpc/contracts";
import type { RpcContext } from "./context";
import { type RpcCompatibleResult, toRpcData } from "./errors";

const rpcLogger = getAppLogger("rpc", "handler");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function summarizeRpcInput(args: unknown[]): unknown {
  if (args.length === 0) {
    return undefined;
  }
  const first = args[0];
  if (!isRecord(first)) {
    return undefined;
  }

  const input = first.input;
  if (!isRecord(input)) {
    return undefined;
  }

  const summary: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (isRecord(value)) {
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
        `RPC handler returned failure [${result.status}]: ${JSON.stringify(result.error)}`,
        {
          status: result.status,
          error: result.error,
          input: summarizeRpcInput(args),
        }
      );
    }
    return toRpcData(Promise.resolve(result));
  };
}

const rpc = implement(rpcContract)
  .$context<RpcContext>()
  .$config({ initialOutputValidationIndex: -1 });

export const rpcRouter = rpc.router({
  apiKey: {
    getAll: rpc.apiKey.getAll.handler(rpcHandler(() => getApiKeysResult())),
    create: rpc.apiKey.create.handler(
      rpcHandler(({ input }) =>
        postApiKeysResult({
          name: input.name ?? undefined,
        })
      )
    ),
    delete: rpc.apiKey.delete.handler(
      rpcHandler(({ input }) => deleteApiKeyResult(input.keyId))
    ),
  },
  integration: {
    getAll: rpc.integration.getAll.handler(
      rpcHandler(({ input }) => getIntegrationsResult(input.type))
    ),
    get: rpc.integration.get.handler(
      rpcHandler(({ input }) => getIntegrationResult(input.integrationId))
    ),
    create: rpc.integration.create.handler(
      rpcHandler(({ input }) =>
        postIntegrationsResult({
          name: input.name,
          type: input.type,
          config: input.config,
        })
      )
    ),
    update: rpc.integration.update.handler(
      rpcHandler(({ input }) =>
        putIntegrationResult(input.integrationId, {
          name: input.name,
          config: input.config,
        })
      )
    ),
    delete: rpc.integration.delete.handler(
      rpcHandler(({ input }) => deleteIntegrationResult(input.integrationId))
    ),
    testConnection: rpc.integration.testConnection.handler(
      rpcHandler(({ input }) => postIntegrationTestResult(input.integrationId))
    ),
    testCredentials: rpc.integration.testCredentials.handler(
      rpcHandler(({ input }) =>
        postIntegrationsTestResult({
          type: input.type,
          config: input.config,
        })
      )
    ),
  },
  workflow: {
    getAll: rpc.workflow.getAll.handler(rpcHandler(() => getWorkflows())),
    getById: rpc.workflow.getById.handler(
      rpcHandler(({ input }) => getWorkflow(input.workflowId))
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
      rpcHandler(({ input }) =>
        patchWorkflow(input.workflowId, {
          name: input.name,
          description: input.description,
          graph: input.graph,
          mode: input.mode,
        })
      )
    ),
    delete: rpc.workflow.delete.handler(
      rpcHandler(({ input }) => deleteWorkflow(input.workflowId))
    ),
    duplicate: rpc.workflow.duplicate.handler(
      rpcHandler(({ input }) => postWorkflowDuplicate(input.workflowId))
    ),
    getCurrent: rpc.workflow.getCurrent.handler(
      rpcHandler(() => getWorkflowsCurrent())
    ),
    saveCurrent: rpc.workflow.saveCurrent.handler(
      rpcHandler(({ input }) =>
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
        });
      })
    ),
    getExecutions: rpc.workflow.getExecutions.handler(
      rpcHandler(({ input }) => getWorkflowExecutionsResult(input.workflowId))
    ),
    getExecutionsGlobal: rpc.workflow.getExecutionsGlobal.handler(
      rpcHandler(({ input }) =>
        getWorkflowExecutionsGlobalResult({
          workflowIds: input.workflowIds,
          statuses: input.statuses,
          limit: input.limit,
          cursor: input.cursor,
        })
      )
    ),
    bulkLifecycle: rpc.workflow.bulkLifecycle.handler(
      rpcHandler(({ input }) =>
        postWorkflowsBulkLifecycleResult({
          workflowIds: input.workflowIds,
          action: input.action,
        })
      )
    ),
    deleteExecutions: rpc.workflow.deleteExecutions.handler(
      rpcHandler(({ input }) =>
        deleteWorkflowExecutionsResult(input.workflowId)
      )
    ),
    getExecutionLogs: rpc.workflow.getExecutionLogs.handler(
      rpcHandler(({ input }) => getExecutionLogsResult(input.executionId))
    ),
    getExecutionEvents: rpc.workflow.getExecutionEvents.handler(
      rpcHandler(({ input }) => getExecutionEventsResult(input.executionId))
    ),
    cancelExecution: rpc.workflow.cancelExecution.handler(
      rpcHandler(({ input }) => postExecutionCancelResult(input.executionId))
    ),
    getExecutionStatus: rpc.workflow.getExecutionStatus.handler(
      rpcHandler(({ input }) => getExecutionStatusResult(input.executionId))
    ),
  },
});
