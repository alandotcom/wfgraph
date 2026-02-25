import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { uniq } from "es-toolkit/array";
import { db } from "@/backend/lib/db";
import { workflowExecutions, workflows } from "@/backend/lib/db/schema";
import { responseFromServiceResult } from "@/backend/lib/http/response-from-service-result";
import { getAppLogger } from "@/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "@/backend/lib/service-result";
import { getErrorMessage } from "@/shared/utils";

const workflowGlobalExecutionsLogger = getAppLogger(
  "workflow",
  "global-executions"
);

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

type ExecutionCursor = {
  startedAt: string;
  id: string;
};

type GlobalExecutionItem = {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowIsPaused: boolean;
  status: "pending" | "running" | "waiting" | "success" | "error" | "cancelled";
  triggerType: "manual" | "webhook" | "event" | null;
  runMode: "live" | "test";
  triggerEventType: string | null;
  correlationKey: string | null;
  workflowRunId: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string;
  waitingAt: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  duration: string | null;
};

type WorkflowExecutionsGlobalResult = {
  items: GlobalExecutionItem[];
  nextCursor: ExecutionCursor | null;
};

type WorkflowExecutionsGlobalError = { error: string };

type WorkflowExecutionsGlobalInput = {
  workflowIds?: string[];
  statuses?: Array<
    "pending" | "running" | "waiting" | "success" | "error" | "cancelled"
  >;
  limit?: number;
  cursor?: ExecutionCursor;
};

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function resolveLimit(limit: number | undefined): number | null {
  const requestedLimit = limit ?? DEFAULT_LIMIT;

  if (requestedLimit < 1 || requestedLimit > MAX_LIMIT) {
    return null;
  }

  return requestedLimit;
}

function buildFilters(input: {
  workflowIds?: string[];
  statuses?: WorkflowExecutionsGlobalInput["statuses"];
  cursor?: ExecutionCursor;
}) {
  const filters: SQL[] = [];

  if (input.workflowIds && input.workflowIds.length > 0) {
    filters.push(inArray(workflowExecutions.workflowId, input.workflowIds));
  }

  if (input.statuses && input.statuses.length > 0) {
    filters.push(inArray(workflowExecutions.status, input.statuses));
  }

  if (!input.cursor) {
    return { filters };
  }

  const cursorDate = new Date(input.cursor.startedAt);
  if (Number.isNaN(cursorDate.getTime())) {
    return { filters, cursorError: "Invalid cursor.startedAt timestamp" };
  }

  const cursorFilter = or(
    lt(workflowExecutions.startedAt, cursorDate),
    and(
      eq(workflowExecutions.startedAt, cursorDate),
      lt(workflowExecutions.id, input.cursor.id)
    )
  );
  if (cursorFilter) {
    filters.push(cursorFilter);
  }

  return { filters };
}

function toGlobalExecutionItem(row: {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowIsPaused: boolean;
  status: "pending" | "running" | "waiting" | "success" | "error" | "cancelled";
  triggerType: "manual" | "webhook" | "event" | null;
  runMode: "live" | "test";
  triggerEventType: string | null;
  correlationKey: string | null;
  workflowRunId: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: Date;
  waitingAt: Date | null;
  cancelledAt: Date | null;
  completedAt: Date | null;
  duration: string | null;
}): GlobalExecutionItem {
  return {
    id: row.id,
    workflowId: row.workflowId,
    workflowName: row.workflowName,
    workflowIsPaused: row.workflowIsPaused,
    status: row.status,
    triggerType: row.triggerType,
    runMode: row.runMode,
    triggerEventType: row.triggerEventType,
    correlationKey: row.correlationKey,
    workflowRunId: row.workflowRunId,
    input: row.input,
    output: row.output,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    waitingAt: toIso(row.waitingAt),
    cancelledAt: toIso(row.cancelledAt),
    completedAt: toIso(row.completedAt),
    duration: row.duration,
  };
}

function buildNextCursor(input: {
  hasMore: boolean;
  pageRows: Array<{ id: string; startedAt: Date }>;
}): ExecutionCursor | null {
  const lastRow = input.pageRows.at(-1);
  if (!(input.hasMore && lastRow)) {
    return null;
  }

  return {
    startedAt: lastRow.startedAt.toISOString(),
    id: lastRow.id,
  };
}

export async function getWorkflowExecutionsGlobalResult(
  input: WorkflowExecutionsGlobalInput
): Promise<
  ServiceResult<
    WorkflowExecutionsGlobalResult,
    400 | 500,
    WorkflowExecutionsGlobalError
  >
> {
  const requestLogger = workflowGlobalExecutionsLogger.with({
    workflowFilterCount: input.workflowIds?.length ?? 0,
    statusFilterCount: input.statuses?.length ?? 0,
    hasCursor: input.cursor !== undefined,
  });

  try {
    const workflowIds = input.workflowIds ? uniq(input.workflowIds) : undefined;
    const statuses = input.statuses ? uniq(input.statuses) : undefined;
    const requestedLimit = resolveLimit(input.limit);

    if (!requestedLimit) {
      return failure(400, {
        error: `Limit must be between 1 and ${MAX_LIMIT}`,
      });
    }

    const { filters, cursorError } = buildFilters({
      workflowIds,
      statuses,
      cursor: input.cursor,
    });

    if (cursorError) {
      return failure(400, { error: cursorError });
    }

    const rows = await db
      .select({
        id: workflowExecutions.id,
        workflowId: workflowExecutions.workflowId,
        workflowName: workflows.name,
        workflowIsPaused: workflows.isPaused,
        status: workflowExecutions.status,
        triggerType: workflowExecutions.triggerType,
        runMode: workflowExecutions.runMode,
        triggerEventType: workflowExecutions.triggerEventType,
        correlationKey: workflowExecutions.correlationKey,
        workflowRunId: workflowExecutions.workflowRunId,
        input: workflowExecutions.input,
        output: workflowExecutions.output,
        error: workflowExecutions.error,
        startedAt: workflowExecutions.startedAt,
        waitingAt: workflowExecutions.waitingAt,
        cancelledAt: workflowExecutions.cancelledAt,
        completedAt: workflowExecutions.completedAt,
        duration: workflowExecutions.duration,
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(workflowExecutions.startedAt), desc(workflowExecutions.id))
      .limit(requestedLimit + 1);

    const hasMore = rows.length > requestedLimit;
    const pageRows = hasMore ? rows.slice(0, requestedLimit) : rows;

    return success({
      items: pageRows.map(toGlobalExecutionItem),
      nextCursor: buildNextCursor({ hasMore, pageRows }),
    });
  } catch (error) {
    requestLogger.error(
      `Failed to get global workflow executions: ${getErrorMessage(error)}`,
      { error }
    );
    return failure(500, {
      error:
        error instanceof Error
          ? error.message
          : "Failed to get global workflow executions",
    });
  }
}

export async function getWorkflowExecutionsGlobal(
  input: WorkflowExecutionsGlobalInput
) {
  return responseFromServiceResult(
    await getWorkflowExecutionsGlobalResult(input)
  );
}
