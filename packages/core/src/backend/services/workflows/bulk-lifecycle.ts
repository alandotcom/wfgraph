import { eq } from "drizzle-orm";
import { uniq } from "es-toolkit/array";
import { db } from "#src/backend/lib/db/index";
import { workflows } from "#src/backend/lib/db/schema";
import { getAppLogger } from "#src/backend/lib/logger";
import {
  failure,
  type ServiceFailureKind,
  type ServiceResult,
  success,
} from "#src/backend/lib/service-result";
import { getErrorMessage } from "@rova/shared/utils";

const workflowsBulkLifecycleLogger = getAppLogger("workflow", "bulk-lifecycle");

type WorkflowBulkAction = "pause" | "resume" | "delete";

type WorkflowBulkLifecycleInput = {
  workflowIds: string[];
  action: WorkflowBulkAction;
  /**
   * How one workflow is deleted, handed in because deleting has moved to Effect
   * while this service has not: the router runs `deleteWorkflow` on the app's
   * runtime and passes the promise it produces. Batch 3 of stage 3b turns this
   * function into an Effect of its own, at which point it calls `deleteWorkflow`
   * directly and this field goes away.
   */
  deleteOne: (
    workflowId: string
  ) => Promise<ServiceResult<unknown, ServiceFailureKind, { error: string }>>;
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
  ServiceResult<
    WorkflowBulkLifecycleResult,
    "internal",
    WorkflowBulkLifecycleError
  >
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
          const deletion = await input.deleteOne(workflowId);

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
    return failure("internal", {
      error:
        error instanceof Error
          ? error.message
          : "Failed bulk workflow lifecycle action",
    });
  }
}
