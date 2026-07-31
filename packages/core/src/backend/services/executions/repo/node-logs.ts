import { desc, eq } from "drizzle-orm";
import type { Effect } from "effect";
import { workflowExecutionLogs } from "#src/backend/lib/db/schema";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import type { WorkflowExecutionLog } from "#src/backend/services/executions/repo/contracts";

/** The `workflow_execution_logs` slice of `ExecutionRepo`, one row per node attempt. */
export type NodeLogsRepoMethods = {
  /** Open the run-log row for a node, answering the row's id. */
  readonly openNodeLog: (input: {
    executionId: string;
    nodeId: string;
    nodeName: string;
    nodeType: string;
    input?: unknown;
  }) => Effect.Effect<string, DatabaseError>;
  /** Close a row `openNodeLog` opened. */
  readonly closeNodeLog: (input: {
    logId: string;
    status: "success" | "error";
    output?: unknown;
    error?: string;
    durationMs: number;
  }) => Effect.Effect<void, DatabaseError>;
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
