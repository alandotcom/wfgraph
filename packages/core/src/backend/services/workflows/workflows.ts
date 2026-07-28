import { desc } from "drizzle-orm";
import { db } from "#src/backend/lib/db/index";
import { workflows } from "#src/backend/lib/db/schema";
import { getAppLogger } from "#src/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "#src/backend/lib/service-result";
import { toWorkflowApiPayload } from "#src/backend/services/workflows/workflow-mappers";
import { getErrorMessage } from "@rova/shared/utils";
import type {
  ApiErrorPayload,
  WorkflowApiPayload,
} from "@rova/shared/workflow/api-contracts";

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
