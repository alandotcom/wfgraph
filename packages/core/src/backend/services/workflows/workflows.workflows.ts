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
import type {
  ApiErrorPayload,
  WorkflowApiPayload,
} from "@/shared/workflow/api-contracts";

const workflowsLogger = getAppLogger("workflow", "list");

type GetWorkflowsResult = ServiceResult<
  WorkflowApiPayload[],
  500,
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
    workflowsLogger.error("Failed to get workflows", { error });
    return failure(500, {
      error: error instanceof Error ? error.message : "Failed to get workflows",
    });
  }
}
