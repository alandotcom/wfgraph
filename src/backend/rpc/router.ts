import { implement } from "@orpc/server";
import { deleteApiKey } from "@/backend/services/api-keys/api-key.api-keys";
import {
  getApiKeys,
  postApiKeys,
} from "@/backend/services/api-keys/api-keys.api-keys";
import {
  deleteIntegration,
  getIntegration,
  getIntegrations,
  postIntegrations,
  postIntegrationsTest,
  postIntegrationTest,
  putIntegration,
} from "@/backend/services/integrations/integrations.integrations";
import { postWorkflowExecute } from "@/backend/services/workflow/workflow-execute.workflow";
import { postExecutionCancel } from "@/backend/services/workflows/execution-cancel.workflows";
import { getExecutionEvents } from "@/backend/services/workflows/execution-events.workflows";
import { getExecutionLogs } from "@/backend/services/workflows/execution-logs.workflows";
import { getExecutionStatus } from "@/backend/services/workflows/execution-status.workflows";
import {
  deleteWorkflow,
  getWorkflow,
  patchWorkflow,
} from "@/backend/services/workflows/workflow.workflows";
import { postWorkflowDuplicate } from "@/backend/services/workflows/workflow-duplicate.workflows";
import {
  deleteWorkflowExecutions,
  getWorkflowExecutions,
} from "@/backend/services/workflows/workflow-executions.workflows";
import { postWorkflowWebhook } from "@/backend/services/workflows/workflow-webhook.workflows";
import { getWorkflows } from "@/backend/services/workflows/workflows.workflows";
import { postWorkflowsCreate } from "@/backend/services/workflows/workflows-create.workflows";
import {
  getWorkflowsCurrent,
  postWorkflowsCurrent,
} from "@/backend/services/workflows/workflows-current.workflows";
import { rpcContract } from "@/shared/rpc/contracts";
import type { RpcContext } from "./context";
import { toRpcData } from "./errors";

const rpc = implement(rpcContract).$context<RpcContext>();

export const rpcRouter = rpc.router({
  apiKey: {
    getAll: rpc.apiKey.getAll.handler(() => toRpcData(getApiKeys())),
    create: rpc.apiKey.create.handler(({ input }) =>
      toRpcData(
        postApiKeys({
          name: input.name ?? undefined,
        })
      )
    ),
    delete: rpc.apiKey.delete.handler(({ input }) =>
      toRpcData(deleteApiKey(input.keyId))
    ),
  },
  integration: {
    getAll: rpc.integration.getAll.handler(({ input }) =>
      toRpcData(getIntegrations(input.type))
    ),
    get: rpc.integration.get.handler(({ input }) =>
      toRpcData(getIntegration(input.integrationId))
    ),
    create: rpc.integration.create.handler(({ input }) =>
      toRpcData(
        postIntegrations({
          name: input.name,
          type: input.type,
          config: input.config,
        })
      )
    ),
    update: rpc.integration.update.handler(({ input }) =>
      toRpcData(
        putIntegration(input.integrationId, {
          name: input.name,
          config: input.config,
        })
      )
    ),
    delete: rpc.integration.delete.handler(({ input }) =>
      toRpcData(deleteIntegration(input.integrationId))
    ),
    testConnection: rpc.integration.testConnection.handler(({ input }) =>
      toRpcData(postIntegrationTest(input.integrationId))
    ),
    testCredentials: rpc.integration.testCredentials.handler(({ input }) =>
      toRpcData(
        postIntegrationsTest({
          type: input.type,
          config: input.config,
        })
      )
    ),
  },
  workflow: {
    getAll: rpc.workflow.getAll.handler(() => toRpcData(getWorkflows())),
    getById: rpc.workflow.getById.handler(({ input }) =>
      toRpcData(getWorkflow(input.workflowId))
    ),
    create: rpc.workflow.create.handler(({ input }) =>
      toRpcData(
        postWorkflowsCreate({
          name: input.name,
          description: input.description,
          graph: input.graph,
        })
      )
    ),
    update: rpc.workflow.update.handler(({ input }) =>
      toRpcData(
        patchWorkflow(input.workflowId, {
          name: input.name,
          description: input.description,
          graph: input.graph,
        })
      )
    ),
    delete: rpc.workflow.delete.handler(({ input }) =>
      toRpcData(deleteWorkflow(input.workflowId))
    ),
    duplicate: rpc.workflow.duplicate.handler(({ input }) =>
      toRpcData(postWorkflowDuplicate(input.workflowId))
    ),
    getCurrent: rpc.workflow.getCurrent.handler(() =>
      toRpcData(getWorkflowsCurrent())
    ),
    saveCurrent: rpc.workflow.saveCurrent.handler(({ input }) =>
      toRpcData(
        postWorkflowsCurrent({
          graph: input.graph,
        })
      )
    ),
    execute: rpc.workflow.execute.handler(({ input }) =>
      toRpcData(
        postWorkflowExecute(input.workflowId, {
          input: input.input,
          dryRun: input.dryRun,
        })
      )
    ),
    triggerWebhook: rpc.workflow.triggerWebhook.handler(
      ({ context, input }) => {
        let dryRunQuery: "true" | "false" | undefined;
        if (input.dryRun === true) {
          dryRunQuery = "true";
        } else if (input.dryRun === false) {
          dryRunQuery = "false";
        }

        return toRpcData(
          postWorkflowWebhook({
            workflowId: input.workflowId,
            authHeader: context.headers.get("Authorization"),
            dryRunQuery,
            dryRunHeader: null,
            body: input.input ?? {},
          })
        );
      }
    ),
    getExecutions: rpc.workflow.getExecutions.handler(({ input }) =>
      toRpcData(getWorkflowExecutions(input.workflowId))
    ),
    deleteExecutions: rpc.workflow.deleteExecutions.handler(({ input }) =>
      toRpcData(deleteWorkflowExecutions(input.workflowId))
    ),
    getExecutionLogs: rpc.workflow.getExecutionLogs.handler(({ input }) =>
      toRpcData(getExecutionLogs(input.executionId))
    ),
    getExecutionEvents: rpc.workflow.getExecutionEvents.handler(({ input }) =>
      toRpcData(getExecutionEvents(input.executionId))
    ),
    cancelExecution: rpc.workflow.cancelExecution.handler(({ input }) =>
      toRpcData(postExecutionCancel(input.executionId))
    ),
    getExecutionStatus: rpc.workflow.getExecutionStatus.handler(({ input }) =>
      toRpcData(getExecutionStatus(input.executionId))
    ),
  },
});
