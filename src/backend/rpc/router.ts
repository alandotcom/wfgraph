import { implement } from "@orpc/server";
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
import { postWorkflowWebhookResult } from "@/backend/services/workflows/workflow-webhook.workflows";
import { getWorkflows } from "@/backend/services/workflows/workflows.workflows";
import { postWorkflowsCreate } from "@/backend/services/workflows/workflows-create.workflows";
import {
  getWorkflowsCurrent,
  postWorkflowsCurrent,
} from "@/backend/services/workflows/workflows-current.workflows";
import { rpcContract } from "@/shared/rpc/contracts";
import type { RpcContext } from "./context";
import {
  isRpcCompatibleResult,
  type RpcCompatibleResult,
  toRpcData,
} from "./errors";

function asRpcHandler<TArgs extends unknown[], TOutput>(
  handler: (
    ...args: TArgs
  ) => RpcCompatibleResult<TOutput> | Promise<RpcCompatibleResult<TOutput>>
): (...args: TArgs) => Promise<TOutput> {
  return handler as unknown as (...args: TArgs) => Promise<TOutput>;
}

const rpc = implement(rpcContract)
  .$context<RpcContext>()
  .$config({ initialOutputValidationIndex: -1 })
  .use(async ({ next }) => {
    const result = await next();
    const output = await Promise.resolve(result.output);

    return {
      ...result,
      output: isRpcCompatibleResult(output) ? await toRpcData(output) : output,
    };
  });

export const rpcRouter = rpc.router({
  apiKey: {
    getAll: rpc.apiKey.getAll.handler(asRpcHandler(() => getApiKeysResult())),
    create: rpc.apiKey.create.handler(
      asRpcHandler(({ input }) =>
        postApiKeysResult({
          name: input.name ?? undefined,
        })
      )
    ),
    delete: rpc.apiKey.delete.handler(
      asRpcHandler(({ input }) => deleteApiKeyResult(input.keyId))
    ),
  },
  integration: {
    getAll: rpc.integration.getAll.handler(
      asRpcHandler(({ input }) => getIntegrationsResult(input.type))
    ),
    get: rpc.integration.get.handler(
      asRpcHandler(({ input }) => getIntegrationResult(input.integrationId))
    ),
    create: rpc.integration.create.handler(
      asRpcHandler(({ input }) =>
        postIntegrationsResult({
          name: input.name,
          type: input.type,
          config: input.config,
        })
      )
    ),
    update: rpc.integration.update.handler(
      asRpcHandler(({ input }) =>
        putIntegrationResult(input.integrationId, {
          name: input.name,
          config: input.config,
        })
      )
    ),
    delete: rpc.integration.delete.handler(
      asRpcHandler(({ input }) => deleteIntegrationResult(input.integrationId))
    ),
    testConnection: rpc.integration.testConnection.handler(
      asRpcHandler(({ input }) =>
        postIntegrationTestResult(input.integrationId)
      )
    ),
    testCredentials: rpc.integration.testCredentials.handler(
      asRpcHandler(({ input }) =>
        postIntegrationsTestResult({
          type: input.type,
          config: input.config,
        })
      )
    ),
  },
  workflow: {
    getAll: rpc.workflow.getAll.handler(asRpcHandler(() => getWorkflows())),
    getById: rpc.workflow.getById.handler(
      asRpcHandler(({ input }) => getWorkflow(input.workflowId))
    ),
    create: rpc.workflow.create.handler(
      asRpcHandler(({ input }) =>
        postWorkflowsCreate({
          name: input.name,
          description: input.description,
          graph: input.graph,
        })
      )
    ),
    update: rpc.workflow.update.handler(
      asRpcHandler(({ input }) =>
        patchWorkflow(input.workflowId, {
          name: input.name,
          description: input.description,
          graph: input.graph,
        })
      )
    ),
    delete: rpc.workflow.delete.handler(
      asRpcHandler(({ input }) => deleteWorkflow(input.workflowId))
    ),
    duplicate: rpc.workflow.duplicate.handler(
      asRpcHandler(({ input }) => postWorkflowDuplicate(input.workflowId))
    ),
    getCurrent: rpc.workflow.getCurrent.handler(
      asRpcHandler(() => getWorkflowsCurrent())
    ),
    saveCurrent: rpc.workflow.saveCurrent.handler(
      asRpcHandler(({ input }) =>
        postWorkflowsCurrent({
          graph: input.graph,
        })
      )
    ),
    execute: rpc.workflow.execute.handler(
      asRpcHandler(({ input }) =>
        postWorkflowExecuteResult(input.workflowId, {
          input: input.input,
          dryRun: input.dryRun,
        })
      )
    ),
    triggerWebhook: rpc.workflow.triggerWebhook.handler(
      asRpcHandler(({ context, input }) => {
        let dryRunQuery: "true" | "false" | undefined;
        if (input.dryRun === true) {
          dryRunQuery = "true";
        } else if (input.dryRun === false) {
          dryRunQuery = "false";
        }

        return postWorkflowWebhookResult({
          workflowId: input.workflowId,
          authHeader: context.headers.get("Authorization"),
          dryRunQuery,
          dryRunHeader: null,
          body: input.input ?? {},
        });
      })
    ),
    getExecutions: rpc.workflow.getExecutions.handler(
      asRpcHandler(({ input }) => getWorkflowExecutionsResult(input.workflowId))
    ),
    deleteExecutions: rpc.workflow.deleteExecutions.handler(
      asRpcHandler(({ input }) =>
        deleteWorkflowExecutionsResult(input.workflowId)
      )
    ),
    getExecutionLogs: rpc.workflow.getExecutionLogs.handler(
      asRpcHandler(({ input }) => getExecutionLogsResult(input.executionId))
    ),
    getExecutionEvents: rpc.workflow.getExecutionEvents.handler(
      asRpcHandler(({ input }) => getExecutionEventsResult(input.executionId))
    ),
    cancelExecution: rpc.workflow.cancelExecution.handler(
      asRpcHandler(({ input }) => postExecutionCancelResult(input.executionId))
    ),
    getExecutionStatus: rpc.workflow.getExecutionStatus.handler(
      asRpcHandler(({ input }) => getExecutionStatusResult(input.executionId))
    ),
  },
});
