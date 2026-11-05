import { and, eq, inArray, sql } from "drizzle-orm";
import type { Effect } from "effect";
import { workflowExecutionLogs } from "#src/backend/lib/db/schema";
import type {
  WfGraphDatabase,
  WfGraphTransaction,
} from "#src/backend/lib/db/index";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import type {
  OwnerFence,
  WorkflowExecutionLog,
} from "#src/backend/services/executions/repo/contracts";
import { nodeLogId } from "#src/backend/services/executions/repo/fencing";
import type { JsonValue } from "@wfgraph/shared/types/json";

type Executor = WfGraphDatabase | WfGraphTransaction;

export type OpenNodeLogInput = {
  executionId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  input?: JsonValue | undefined;
};

export type CloseNodeLogInput = {
  logId: string;
  status: "success" | "error";
  output?: JsonValue | undefined;
  error?: string | undefined;
  durationMs: number;
};

/** The `workflow_execution_logs` slice of `ExecutionRepo`, one row per node attempt. */
export type NodeLogsRepoMethods = {
  /**
   * Open the run-log row for a node, answering the row's id.
   *
   * The id derives from the Execution and the node (`nodeLogId`), and a second
   * open of the same node answers the row the first one inserted, untouched.
   * A re-run of the step that opens the row therefore writes nothing new.
   */
  readonly openNodeLog: (
    input: OpenNodeLogInput
  ) => Effect.Effect<string, DatabaseError>;
  /**
   * Close a row `openNodeLog` opened, whatever it holds, which is how a retry
   * corrects the verdict an earlier attempt wrote. The fenced close
   * (`ExecutionRepo.fenced`) closes only a row that is `running` or `error`.
   */
  readonly closeNodeLog: (
    input: CloseNodeLogInput
  ) => Effect.Effect<void, DatabaseError>;
  /**
   * Close every row of one run that is still open, as cancelled.
   *
   * For the rows a killed branch run left behind: it was stopped where it
   * stood, so nothing inside it can close its own row. The caller states when
   * this is safe to call.
   */
  readonly cancelOpenNodeLogs: (
    executionId: string
  ) => Effect.Effect<void, DatabaseError>;
  /**
   * What each node of one run that succeeded left behind, by node id.
   *
   * This is how a branch run reads the outputs above the node it starts at. A
   * node that failed or is still going is absent, and a node with several rows
   * answers with its newest.
   */
  readonly readNodeOutputs: (
    executionId: string
  ) => Effect.Effect<Record<string, JsonValue>, DatabaseError>;
  /**
   * Which node ids each of these runs has a log row for, keyed by execution id.
   *
   * A Migration asks this of every run it is classifying at once, because a node
   * the target version adds above a parked Wait has no memoized step for the run
   * and would execute on the wake. Every status counts, a skipped node included:
   * the question is whether the run reached the node at all. A run with no log
   * rows is absent from the map, as it is from `listWaitingStatesForExecutions`.
   */
  readonly listLoggedNodeIdsForExecutions: (
    executionIds: string[]
  ) => Effect.Effect<Map<string, Set<string>>, DatabaseError>;
  /** One run's node logs, newest first, whole rows. */
  readonly listLogs: (
    executionId: string
  ) => Effect.Effect<WorkflowExecutionLog[], DatabaseError>;
  /**
   * The same logs reduced to what the status poll reads. The two columns are
   * the point: the editor asks for this every two seconds while the Runs view is
   * open, and the rows carry a node's whole input and output.
   */
  readonly listNodeStatuses: (
    executionId: string
  ) => Effect.Effect<
    Array<Pick<WorkflowExecutionLog, "nodeId" | "status">>,
    DatabaseError
  >;
};

/** The insert behind `openNodeLog`, on whichever handle the caller holds. */
export function openNodeLogWrite(input: OpenNodeLogInput) {
  return async (db: Executor): Promise<string> => {
    const id = nodeLogId(input.executionId, input.nodeId);
    await db
      .insert(workflowExecutionLogs)
      .values({
        id,
        executionId: input.executionId,
        nodeId: input.nodeId,
        nodeName: input.nodeName,
        nodeType: input.nodeType,
        status: "running",
        input: input.input,
        startedAt: new Date(),
      })
      .onConflictDoNothing({ target: workflowExecutionLogs.id });
    return id;
  };
}

/**
 * The update behind `closeNodeLog`. Given a fence, it closes only a row of the
 * fenced Execution that is `running` or `error`. `runWithStepLog` closes a row
 * as `error` before it rethrows a retriable error, so a later attempt of the
 * node can still correct that verdict, while a row closed with any other
 * status keeps it.
 */
export function closeNodeLogWrite(
  input: CloseNodeLogInput,
  fence?: OwnerFence
) {
  return async (db: Executor): Promise<void> => {
    await db
      .update(workflowExecutionLogs)
      .set({
        status: input.status,
        // Drizzle leaves an undefined key out of the update, so an absent
        // payload is written as null to clear what an earlier close wrote.
        output: input.output ?? null,
        error: input.error ?? null,
        completedAt: new Date(),
        duration: input.durationMs.toString(),
      })
      .where(
        and(
          eq(workflowExecutionLogs.id, input.logId),
          fence === undefined
            ? undefined
            : and(
                eq(workflowExecutionLogs.executionId, fence.executionId),
                inArray(workflowExecutionLogs.status, ["running", "error"])
              )
        )
      );
  };
}

/** The update behind `cancelOpenNodeLogs`. */
export function cancelOpenNodeLogsWrite(executionId: string) {
  return async (db: Executor): Promise<void> => {
    await db
      .update(workflowExecutionLogs)
      .set({
        status: "cancelled",
        completedAt: new Date(),
        // Same reasoning as `finishRun`: the row holds when it started, and the
        // caller's clock belongs to a body that replays.
        duration: sql`round(extract(epoch from ((now() at time zone 'utc') - ${workflowExecutionLogs.startedAt})) * 1000)::text`,
      })
      .where(
        and(
          eq(workflowExecutionLogs.executionId, executionId),
          inArray(workflowExecutionLogs.status, ["pending", "running"])
        )
      );
  };
}

/** Builds the `workflow_execution_logs` slice of `ExecutionRepo` over one database. */
export function makeNodeLogsMethods(
  database: Database["Service"]
): NodeLogsRepoMethods {
  return {
    openNodeLog: (input) => database.query(openNodeLogWrite(input)),
    closeNodeLog: (input) => database.query(closeNodeLogWrite(input)),
    cancelOpenNodeLogs: (executionId) =>
      database.query(cancelOpenNodeLogsWrite(executionId)),

    readNodeOutputs: (executionId) =>
      database.query(async (db) => {
        const rows = await db.query.workflowExecutionLogs.findMany({
          where: {
            executionId,
            status: "success",
          },
          columns: { nodeId: true, output: true },
          orderBy: { timestamp: "asc" },
        });

        const outputs: Record<string, JsonValue> = {};
        for (const row of rows) {
          outputs[row.nodeId] = row.output ?? null;
        }

        return outputs;
      }),

    listLoggedNodeIdsForExecutions: (executionIds) =>
      database.query(async (db) => {
        const byExecution = new Map<string, Set<string>>();
        if (executionIds.length === 0) {
          return byExecution;
        }

        const rows = await db
          .selectDistinct({
            executionId: workflowExecutionLogs.executionId,
            nodeId: workflowExecutionLogs.nodeId,
          })
          .from(workflowExecutionLogs)
          .where(inArray(workflowExecutionLogs.executionId, executionIds));

        for (const row of rows) {
          const existing = byExecution.get(row.executionId);
          if (existing) {
            existing.add(row.nodeId);
            continue;
          }
          byExecution.set(row.executionId, new Set([row.nodeId]));
        }

        return byExecution;
      }),

    listLogs: (executionId) =>
      database.query((db) =>
        db.query.workflowExecutionLogs.findMany({
          // `WorkflowExecutionLog` leaves this column out; see its comment.
          columns: { releasedOutlet: false },
          where: { executionId },
          orderBy: { timestamp: "desc" },
        })
      ),

    listNodeStatuses: (executionId) =>
      database.query((db) =>
        db.query.workflowExecutionLogs.findMany({
          where: { executionId },
          columns: { nodeId: true, status: true },
        })
      ),
  };
}
