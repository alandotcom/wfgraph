import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Effect } from "effect";
import { workflowExecutionLogs } from "#src/backend/lib/db/schema";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import type { WorkflowExecutionLog } from "#src/backend/services/executions/repo/contracts";
import type { JsonValue } from "@rova/shared/types/json";

/** The `workflow_execution_logs` slice of `ExecutionRepo`, one row per node attempt. */
export type NodeLogsRepoMethods = {
  /** Open the run-log row for a node, answering the row's id. */
  readonly openNodeLog: (input: {
    executionId: string;
    nodeId: string;
    nodeName: string;
    nodeType: string;
    input?: JsonValue;
  }) => Effect.Effect<string, DatabaseError>;
  /** Close a row `openNodeLog` opened. */
  readonly closeNodeLog: (input: {
    logId: string;
    status: "success" | "error";
    output?: JsonValue;
    error?: string;
    durationMs: number;
  }) => Effect.Effect<void, DatabaseError>;
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
  /** One run's node logs, newest first, whole rows. */
  readonly listLogs: (
    executionId: string
  ) => Effect.Effect<WorkflowExecutionLog[], DatabaseError>;
  /**
   * The same logs reduced to what the status poll reads. The two columns are
   * the point: the editor asks for this every two seconds while a run panel is
   * open, and the rows carry a node's whole input and output.
   */
  readonly listNodeStatuses: (
    executionId: string
  ) => Effect.Effect<
    Array<Pick<WorkflowExecutionLog, "nodeId" | "status">>,
    DatabaseError
  >;
};

/** Builds the `workflow_execution_logs` slice of `ExecutionRepo` over one database. */
export function makeNodeLogsMethods(
  database: Database["Service"]
): NodeLogsRepoMethods {
  return {
    openNodeLog: (input) =>
      database.query(async (db) => {
        const [log] = await db
          .insert(workflowExecutionLogs)
          .values({
            executionId: input.executionId,
            nodeId: input.nodeId,
            nodeName: input.nodeName,
            nodeType: input.nodeType,
            status: "running",
            input: input.input,
            startedAt: new Date(),
          })
          .returning({ id: workflowExecutionLogs.id });

        return log.id;
      }),

    closeNodeLog: (input) =>
      database.query(async (db) => {
        await db
          .update(workflowExecutionLogs)
          .set({
            status: input.status,
            output: input.output,
            error: input.error,
            completedAt: new Date(),
            duration: input.durationMs.toString(),
          })
          .where(eq(workflowExecutionLogs.id, input.logId));
      }),

    cancelOpenNodeLogs: (executionId) =>
      database.query(async (db) => {
        await db
          .update(workflowExecutionLogs)
          .set({
            status: "cancelled",
            completedAt: new Date(),
            // Same reasoning as `finishRun`: the row holds when it started, and
            // the caller's clock belongs to a body that replays.
            duration: sql`round(extract(epoch from ((now() at time zone 'utc') - ${workflowExecutionLogs.startedAt})) * 1000)::text`,
          })
          .where(
            and(
              eq(workflowExecutionLogs.executionId, executionId),
              inArray(workflowExecutionLogs.status, ["pending", "running"])
            )
          );
      }),

    readNodeOutputs: (executionId) =>
      database.query(async (db) => {
        const rows = await db.query.workflowExecutionLogs.findMany({
          where: and(
            eq(workflowExecutionLogs.executionId, executionId),
            eq(workflowExecutionLogs.status, "success")
          ),
          columns: { nodeId: true, output: true },
          orderBy: [asc(workflowExecutionLogs.timestamp)],
        });

        const outputs: Record<string, JsonValue> = {};
        for (const row of rows) {
          outputs[row.nodeId] = row.output ?? null;
        }

        return outputs;
      }),

    listLogs: (executionId) =>
      database.query((db) =>
        db.query.workflowExecutionLogs.findMany({
          where: eq(workflowExecutionLogs.executionId, executionId),
          orderBy: [desc(workflowExecutionLogs.timestamp)],
        })
      ),

    listNodeStatuses: (executionId) =>
      database.query((db) =>
        db.query.workflowExecutionLogs.findMany({
          where: eq(workflowExecutionLogs.executionId, executionId),
          columns: { nodeId: true, status: true },
        })
      ),
  };
}
