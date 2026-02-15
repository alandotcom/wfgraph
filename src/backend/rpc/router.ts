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
import { type RpcCompatibleResult, toRpcData } from "./errors";

const rpc = implement(rpcContract).$context<RpcContext>();

type Awaitable<T> = T | Promise<T>;

function bindNoInput<TOutput>(
  handler: () => Awaitable<RpcCompatibleResult<TOutput>>
) {
  return () => toRpcData<TOutput>(handler());
}

function bindInput<TInput, TOutput>(
  handler: (input: TInput) => Awaitable<RpcCompatibleResult<TOutput>>
) {
  return ({ input }: { input: TInput }) => toRpcData<TOutput>(handler(input));
}

function bindContextInput<TInput, TOutput>(
  handler: (
    context: RpcContext,
    input: TInput
  ) => Awaitable<RpcCompatibleResult<TOutput>>
) {
  return ({ context, input }: { context: RpcContext; input: TInput }) =>
    toRpcData<TOutput>(handler(context, input));
}

export const rpcRouter = rpc.router({
  apiKey: {
    getAll: rpc.apiKey.getAll.handler(bindNoInput(getApiKeysResult)),
    create: rpc.apiKey.create.handler(
      bindInput((input) =>
        postApiKeysResult({
          name: input.name ?? undefined,
        })
      )
    ),
    delete: rpc.apiKey.delete.handler(
      bindInput((input) => deleteApiKeyResult(input.keyId))
    ),
  },
  integration: {
    getAll: rpc.integration.getAll.handler(
      bindInput((input) => getIntegrationsResult(input.type))
    ),
    get: rpc.integration.get.handler(
      bindInput((input) => getIntegrationResult(input.integrationId))
    ),
    create: rpc.integration.create.handler(
      bindInput((input) =>
        postIntegrationsResult({
          name: input.name,
          type: input.type,
          config: input.config,
        })
      )
    ),
    update: rpc.integration.update.handler(
      bindInput((input) =>
        putIntegrationResult(input.integrationId, {
          name: input.name,
          config: input.config,
        })
      )
    ),
    delete: rpc.integration.delete.handler(
      bindInput((input) => deleteIntegrationResult(input.integrationId))
    ),
    testConnection: rpc.integration.testConnection.handler(
      bindInput((input) => postIntegrationTestResult(input.integrationId))
    ),
    testCredentials: rpc.integration.testCredentials.handler(
      bindInput((input) =>
        postIntegrationsTestResult({
          type: input.type,
          config: input.config,
        })
      )
    ),
  },
  workflow: {
    getAll: rpc.workflow.getAll.handler(bindNoInput(getWorkflows)),
    getById: rpc.workflow.getById.handler(
      bindInput((input) => getWorkflow(input.workflowId))
    ),
    create: rpc.workflow.create.handler(
      bindInput((input) =>
        postWorkflowsCreate({
          name: input.name,
          description: input.description,
          graph: input.graph,
        })
      )
    ),
    update: rpc.workflow.update.handler(
      bindInput((input) =>
        patchWorkflow(input.workflowId, {
          name: input.name,
          description: input.description,
          graph: input.graph,
        })
      )
    ),
    delete: rpc.workflow.delete.handler(
      bindInput((input) => deleteWorkflow(input.workflowId))
    ),
    duplicate: rpc.workflow.duplicate.handler(
      bindInput((input) => postWorkflowDuplicate(input.workflowId))
    ),
    getCurrent: rpc.workflow.getCurrent.handler(
      bindNoInput(getWorkflowsCurrent)
    ),
    saveCurrent: rpc.workflow.saveCurrent.handler(
      bindInput((input) =>
        postWorkflowsCurrent({
          graph: input.graph,
        })
      )
    ),
    execute: rpc.workflow.execute.handler(
      bindInput((input) =>
        postWorkflowExecuteResult(input.workflowId, {
          input: input.input,
          dryRun: input.dryRun,
        })
      )
    ),
    triggerWebhook: rpc.workflow.triggerWebhook.handler(
      bindContextInput((context, input) => {
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
      bindInput((input) => getWorkflowExecutionsResult(input.workflowId))
    ),
    deleteExecutions: rpc.workflow.deleteExecutions.handler(
      bindInput((input) => deleteWorkflowExecutionsResult(input.workflowId))
    ),
    getExecutionLogs: rpc.workflow.getExecutionLogs.handler(
      bindInput((input) => getExecutionLogsResult(input.executionId))
    ),
    getExecutionEvents: rpc.workflow.getExecutionEvents.handler(
      bindInput((input) => getExecutionEventsResult(input.executionId))
    ),
    cancelExecution: rpc.workflow.cancelExecution.handler(
      bindInput((input) => postExecutionCancelResult(input.executionId))
    ),
    getExecutionStatus: rpc.workflow.getExecutionStatus.handler(
      bindInput((input) => getExecutionStatusResult(input.executionId))
    ),
  },
});
