import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Effect } from "effect";
import {
  workflowExecutionLogs,
  workflowExecutionSchedule,
  workflowExecutionSteps,
} from "#src/backend/lib/db/schema";
import type {
  WfGraphDatabase,
  WfGraphTransaction,
} from "#src/backend/lib/db/index";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import type {
  RunFence,
  WorkflowExecutionLog,
} from "#src/backend/services/executions/repo/contracts";
import {
  nodeLogCloseGuard,
  nodeLogCloseSet,
} from "#src/backend/services/executions/repo/release-policy";
import type { JsonValue } from "@wfgraph/shared/types/json";

type Executor = WfGraphDatabase | WfGraphTransaction;

/**
 * The id of a node's run-log row.
 *
 * A node opens its row at most once per Execution, in one durable step whose id
 * is built from the node id (`node:<id>:log-open`, or `wait-start-log-<id>` for
 * a Wait), so the Execution and the node name the step that opens the row. A
 * re-run of that step therefore inserts the same id, and the insert's conflict
 * leaves the first row in place.
 */
export function nodeLogId(executionId: string, nodeId: string): string {
  const digest = createHash("sha256")
    .update(`${executionId}\0${nodeId}`)
    .digest("hex");
  return `log_${digest}`;
}

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
   * Close a row `openNodeLog` opened, whatever it holds. The fenced close
   * (`ExecutionRepo.fenced`) applies only where `nodeLogCloseApplies` says,
   * which is how a retry corrects an `error` an earlier attempt wrote. A
   * close that applies writes the row's `retries` from the step memo rows of
   * its run that carry its node id, as `nodeLogCloseSet` describes.
   */
  readonly closeNodeLog: (
    input: CloseNodeLogInput
  ) => Effect.Effect<void, DatabaseError>;
  /**
   * What each node of one run that succeeded left behind, by node id.
   *
   * A Migration reads this to check that each reference the target version
   * makes to a node the run already passed resolves against that node's
   * output. A node that failed or is still going is absent, and a node with
   * several rows answers with its newest.
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
 * The update behind `closeNodeLog`, one statement whose SET is
 * `nodeLogCloseSet`. Given a fence, it updates only a row of the fenced
 * Execution that `nodeLogCloseGuard` admits, so a later attempt of the node
 * can correct an `error` verdict and a success keeps its own.
 */
export function closeNodeLogWrite(input: CloseNodeLogInput, fence?: RunFence) {
  return async (db: Executor): Promise<void> => {
    await db
      .update(workflowExecutionLogs)
      .set(
        nodeLogCloseSet({
          tables: {
            logs: workflowExecutionLogs,
            schedule: workflowExecutionSchedule,
            steps: workflowExecutionSteps,
          },
          values: {
            status: input.status,
            // An absent payload is written as null to clear what an earlier
            // close wrote.
            output: input.output ?? null,
            error: input.error ?? null,
            completedAt: new Date(),
            duration: input.durationMs.toString(),
          },
        })
      )
      .where(
        and(
          eq(workflowExecutionLogs.id, input.logId),
          fence === undefined
            ? undefined
            : eq(workflowExecutionLogs.executionId, fence.executionId),
          nodeLogCloseGuard({
            logs: workflowExecutionLogs,
            close: input.status,
            fenced: fence !== undefined,
          })
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
