import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { workflows } from "@/backend/lib/db/schema";
import { invalidateInngestFunctionsCache } from "@/backend/lib/inngest/functions";
import { getAppLogger } from "@/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "@/backend/lib/service-result";
import { validateWorkflowConditionConfigs } from "@/backend/lib/workflow-conditions-validation";
import { validateWorkflowGraph } from "@/backend/lib/workflow-graph";
import { validateWorkflowIntegrations } from "@/backend/lib/workflow-integration-validation";
import {
  buildWorkflowUpdateData,
  toWorkflowApiPayload,
} from "@/backend/services/workflows/workflow-mappers";
import { getErrorMessage } from "@rova/shared/utils";
import type {
  ApiErrorPayload,
  WorkflowApiPayload,
} from "@rova/shared/workflow/api-contracts";
import type { SerializedWorkflowGraph } from "@rova/shared/workflow/types";

const workflowServiceLogger = getAppLogger("workflow", "service");

type GetWorkflowResult = ServiceResult<
  WorkflowApiPayload,
  "not_found" | "internal",
  ApiErrorPayload
>;

type PatchWorkflowResult = ServiceResult<
  WorkflowApiPayload,
  "invalid" | "not_found" | "conflict" | "internal",
  ApiErrorPayload
>;

type DeleteWorkflowResult = ServiceResult<
  { success: true },
  "not_found" | "internal",
  ApiErrorPayload
>;

export async function getWorkflow(
  workflowId: string
): Promise<GetWorkflowResult> {
  try {
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return failure("not_found", { error: "Workflow not found" });
    }

    const graphValidation = validateWorkflowGraph(workflow.graph);
    if (!graphValidation.valid) {
      return failure("internal", { error: "Workflow graph is invalid" });
    }

    // Conditions are checked when the graph is written and again before a run,
    // never here: a stored expression that no longer matches its model would
    // otherwise lock the user out of the editor, the one screen that can fix it.
    return success(toWorkflowApiPayload(workflow));
  } catch (error) {
    workflowServiceLogger.error("Failed to get workflow", {
      workflowId,
      error,
    });
    return failure("internal", {
      error: error instanceof Error ? error.message : "Failed to get workflow",
    });
  }
}

export async function patchWorkflow(
  workflowId: string,
  body: {
    name?: string;
    description?: string;
    graph?: unknown;
    mode?: "live" | "test";
  }
): Promise<PatchWorkflowResult> {
  const requestLogger = workflowServiceLogger.with({ workflowId });
  const updateInput: {
    name?: string;
    description?: string;
    graph?: SerializedWorkflowGraph;
    mode?: "live" | "test";
  } = {};

  if (body.description !== undefined) {
    updateInput.description = body.description;
  }
  if (body.mode !== undefined) {
    if (body.mode !== "live" && body.mode !== "test") {
      return failure("invalid", {
        error: "Workflow mode must be live or test",
      });
    }
    updateInput.mode = body.mode;
  }

  try {
    const existingWorkflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!existingWorkflow) {
      return failure("not_found", { error: "Workflow not found" });
    }

    if (body.name !== undefined) {
      const normalizedName = body.name.trim();
      if (!normalizedName) {
        requestLogger.warn("Rejected workflow update with empty name");
        return failure("invalid", { error: "Workflow name is required" });
      }

      const nameConflict = await db.query.workflows.findFirst({
        where: and(
          sql`lower(${workflows.name}) = lower(${normalizedName})`,
          ne(workflows.id, workflowId)
        ),
        columns: { id: true },
      });
      if (nameConflict) {
        requestLogger.warn("Duplicate workflow name on update", {
          workflowName: normalizedName,
        });
        return failure("conflict", {
          error: `Workflow name "${normalizedName}" already exists`,
        });
      }

      updateInput.name = normalizedName;
    }

    if (body.graph !== undefined) {
      const graphValidation = validateWorkflowGraph(body.graph);
      if (!graphValidation.valid) {
        requestLogger.warn("Rejected invalid workflow graph on update", {
          error: graphValidation.error,
        });
        return failure("invalid", { error: graphValidation.error });
      }

      const conditionValidation = validateWorkflowConditionConfigs(
        graphValidation.nodes
      );
      if (!conditionValidation.valid) {
        requestLogger.warn(
          "Rejected workflow update due to invalid condition configuration",
          {
            error: conditionValidation.error,
          }
        );
        return failure("invalid", { error: conditionValidation.error });
      }

      const integrationValidation = await validateWorkflowIntegrations(
        graphValidation.nodes
      );
      if (!integrationValidation.valid) {
        requestLogger.warn(
          "Rejected workflow update due to invalid integrations",
          {
            invalidIntegrationIds: integrationValidation.invalidIds,
          }
        );
        return failure("invalid", {
          error: "Invalid integration references in workflow",
          code: "integration_validation_failed",
          invalidIntegrationIds: integrationValidation.invalidIds ?? [],
        });
      }

      updateInput.graph = graphValidation.graph;
    }

    const updateData = buildWorkflowUpdateData(updateInput);

    const [updatedWorkflow] = await db
      .update(workflows)
      .set(updateData)
      .where(eq(workflows.id, workflowId))
      .returning();

    if (!updatedWorkflow) {
      return failure("not_found", { error: "Workflow not found" });
    }

    invalidateInngestFunctionsCache();

    const modeChanged =
      updateInput.mode !== undefined &&
      updateInput.mode !== existingWorkflow.mode;
    if (modeChanged) {
      requestLogger.info("Workflow mode changed", {
        previousMode: existingWorkflow.mode,
        nextMode: updatedWorkflow.mode,
      });
    }

    requestLogger.info("Workflow updated", {
      workflowName: updatedWorkflow.name,
      hasGraph: updateInput.graph !== undefined,
      mode: updatedWorkflow.mode,
      modeChanged,
    });

    return success(toWorkflowApiPayload(updatedWorkflow));
  } catch (error) {
    requestLogger.error(
      `Failed to update workflow: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
      error:
        error instanceof Error ? error.message : "Failed to update workflow",
    });
  }
}

export async function deleteWorkflow(
  workflowId: string
): Promise<DeleteWorkflowResult> {
  const requestLogger = workflowServiceLogger.with({ workflowId });
  try {
    const existingWorkflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!existingWorkflow) {
      return failure("not_found", { error: "Workflow not found" });
    }

    await db.delete(workflows).where(eq(workflows.id, workflowId));
    invalidateInngestFunctionsCache();

    requestLogger.info("Workflow deleted");

    return success({ success: true as const });
  } catch (error) {
    requestLogger.error(
      `Failed to delete workflow: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
      error:
        error instanceof Error ? error.message : "Failed to delete workflow",
    });
  }
}
