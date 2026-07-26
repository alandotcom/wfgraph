import { desc } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { workflows } from "@/backend/lib/db/schema";
import { getAppLogger } from "@/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "@/backend/lib/service-result";
import { toWorkflowApiPayload } from "@/backend/services/workflows/workflow-mappers.workflows";
import { getErrorMessage } from "@/shared/utils";
import type {
  ApiErrorPayload,
  WorkflowApiPayload,
} from "@/shared/workflow/api-contracts";

const workflowsLogger = getAppLogger("workflow", "list");

type GetWorkflowsResult = ServiceResult<
  WorkflowApiPayload[],
  "internal",
  ApiErrorPayload
>;

export async function getWorkflows(): Promise<GetWorkflowsResult> {
  try {
    const allWorkflows = await db
      .select()
      .from(workflows)
      .orderBy(desc(workflows.updatedAt));

    const mappedWorkflows: WorkflowApiPayload[] =
      allWorkflows.map(toWorkflowApiPayload);

    return success(mappedWorkflows);
  } catch (error) {
    workflowsLogger.error(
      `Failed to get workflows: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
      error: error instanceof Error ? error.message : "Failed to get workflows",
    });
  }
}
