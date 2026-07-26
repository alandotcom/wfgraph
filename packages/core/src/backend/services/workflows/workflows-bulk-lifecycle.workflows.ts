import { eq } from "drizzle-orm";
import { uniq } from "es-toolkit/array";
import { db } from "@/backend/lib/db";
import { workflows } from "@/backend/lib/db/schema";
import { getAppLogger } from "@/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "@/backend/lib/service-result";
import { getErrorMessage } from "@/shared/utils";
import { deleteWorkflow } from "./workflow.workflows";

const workflowsBulkLifecycleLogger = getAppLogger("workflow", "bulk-lifecycle");

type WorkflowBulkAction = "pause" | "resume" | "delete";

type WorkflowBulkLifecycleInput = {
  workflowIds: string[];
  action: WorkflowBulkAction;
};

type WorkflowBulkLifecycleResult = {
  summary: {
    requested: number;
    succeeded: number;
    failed: number;
  };
  results: Array<{
    workflowId: string;
    action: WorkflowBulkAction;
    ok: boolean;
    deleted?: boolean;
    error?: string;
  }>;
};

type WorkflowBulkLifecycleError = { error: string };

async function setWorkflowPausedState(input: {
  workflowId: string;
  isPaused: boolean;
}) {
  const existing = await db.query.workflows.findFirst({
    where: eq(workflows.id, input.workflowId),
    columns: {
      id: true,
      isPaused: true,
    },
  });

  if (!existing) {
    return {
      ok: false,
      error: "Workflow not found",
    } as const;
  }

  if (existing.isPaused === input.isPaused) {
    return {
      ok: true,
    } as const;
  }

  await db
    .update(workflows)
    .set({
      isPaused: input.isPaused,
      updatedAt: new Date(),
    })
    .where(eq(workflows.id, input.workflowId));

  return {
    ok: true,
  } as const;
}

export async function postWorkflowsBulkLifecycleResult(
  input: WorkflowBulkLifecycleInput
): Promise<
  ServiceResult<WorkflowBulkLifecycleResult, 500, WorkflowBulkLifecycleError>
> {
  const workflowIds = uniq(input.workflowIds);
  const requestLogger = workflowsBulkLifecycleLogger.with({
    action: input.action,
    requestedCount: workflowIds.length,
  });

  try {
    const results: WorkflowBulkLifecycleResult["results"] = await Promise.all(
      workflowIds.map(async (workflowId) => {
        if (input.action === "delete") {
          const deletion = await deleteWorkflow(workflowId);

          if (deletion.ok) {
            return {
              workflowId,
              action: input.action,
              ok: true,
              deleted: true,
            };
          }

          return {
            workflowId,
            action: input.action,
            ok: false,
            error: deletion.error.error,
          };
        }

        const pauseUpdate = await setWorkflowPausedState({
          workflowId,
          isPaused: input.action === "pause",
        });

        if (pauseUpdate.ok) {
          return {
            workflowId,
            action: input.action,
            ok: true,
          };
        }

        return {
          workflowId,
          action: input.action,
          ok: false,
          error: pauseUpdate.error,
        };
      })
    );

    const succeeded = results.filter((result) => result.ok).length;

    requestLogger.info("Completed bulk workflow lifecycle action", {
      succeeded,
      failed: results.length - succeeded,
    });

    return success({
      summary: {
        requested: workflowIds.length,
        succeeded,
        failed: results.length - succeeded,
      },
      results,
    });
  } catch (error) {
    requestLogger.error(
      `Failed bulk workflow lifecycle action: ${getErrorMessage(error)}`,
      { error }
    );
    return failure(500, {
      error:
        error instanceof Error
          ? error.message
          : "Failed bulk workflow lifecycle action",
    });
  }
}
