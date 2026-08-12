import { Effect } from "effect";
import { uniq } from "es-toolkit/array";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { InvalidInput } from "#src/backend/lib/effect/failures";
import {
  redactSensitiveData,
  redactSensitiveText,
} from "#src/backend/lib/utils/redact";
import {
  ExecutionRepo,
  type GlobalExecutionRow,
} from "#src/backend/services/executions/repo";
import type {
  WorkflowExecutionStartSource,
  WorkflowExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Where a page resumes from, as it travels to the client and back: an ISO
 * timestamp rather than the `Date` the query compares against.
 *
 * The repository's `ExecutionCursor` is the parsed form of this, and turning one
 * into the other is the work this service does around the query: reading a
 * cursor in means rejecting a timestamp that is not a date, and writing one out
 * means the last row of the page.
 */
type ExecutionCursorPayload = {
  startedAt: string;
  id: string;
};

type GlobalExecutionItem = {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowIsPaused: boolean;
  status: WorkflowExecutionStatus;
  startSource: WorkflowExecutionStartSource | null;
  runMode: "live" | "test";
  startEventName: string | null;
  entityValue: string | null;
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

type WorkflowExecutionsGlobalInput = {
  workflowIds?: string[];
  statuses?: WorkflowExecutionStatus[];
  limit?: number;
  cursor?: ExecutionCursorPayload;
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

function toGlobalExecutionItem(row: GlobalExecutionRow): GlobalExecutionItem {
  return {
    id: row.id,
    workflowId: row.workflowId,
    workflowName: row.workflowName,
    workflowIsPaused: row.workflowIsPaused,
    status: row.status,
    startSource: row.startSource,
    runMode: row.runMode,
    startEventName: row.startEventName,
    entityValue: row.entityValue,
    workflowRunId: row.workflowRunId,
    input: redactSensitiveData(row.input),
    output: redactSensitiveData(row.output),
    error: redactSensitiveText(row.error),
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
}): ExecutionCursorPayload | null {
  const lastRow = input.pageRows.at(-1);
  if (!(input.hasMore && lastRow)) {
    return null;
  }

  return {
    startedAt: lastRow.startedAt.toISOString(),
    id: lastRow.id,
  };
}

/** This module's logger, as the Effect that produces it (see `services/workflows/workflow.ts`). */
const loggerFor = (input: WorkflowExecutionsGlobalInput) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("global-executions").with({
      workflowFilterCount: input.workflowIds?.length ?? 0,
      statusFilterCount: input.statuses?.length ?? 0,
      hasCursor: input.cursor !== undefined,
    })
  );

export const getWorkflowExecutionsGlobal = Effect.fn(
  "getWorkflowExecutionsGlobal"
)(
  function* (input: WorkflowExecutionsGlobalInput) {
    const repo = yield* ExecutionRepo;

    const requestedLimit = resolveLimit(input.limit);
    if (!requestedLimit) {
      return yield* new InvalidInput({
        error: `Limit must be between 1 and ${MAX_LIMIT}`,
      });
    }

    const cursorStartedAt = input.cursor
      ? new Date(input.cursor.startedAt)
      : undefined;
    if (cursorStartedAt && Number.isNaN(cursorStartedAt.getTime())) {
      return yield* new InvalidInput({
        error: "Invalid cursor.startedAt timestamp",
      });
    }

    const rows = yield* repo.listPage({
      workflowIds: input.workflowIds ? uniq(input.workflowIds) : undefined,
      statuses: input.statuses ? uniq(input.statuses) : undefined,
      cursor:
        input.cursor && cursorStartedAt
          ? { startedAt: cursorStartedAt, id: input.cursor.id }
          : undefined,
      // One row past the page, which is how the next cursor is decided without
      // a second count query.
      limit: requestedLimit + 1,
    });

    const hasMore = rows.length > requestedLimit;
    const pageRows = hasMore ? rows.slice(0, requestedLimit) : rows;

    return {
      items: pageRows.map(toGlobalExecutionItem),
      nextCursor: buildNextCursor({ hasMore, pageRows }),
    };
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(input),
          "Failed to get global workflow executions"
        )
      )
    )
);
