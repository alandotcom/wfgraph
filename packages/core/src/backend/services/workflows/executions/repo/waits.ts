import {
  and,
  arrayContains,
  asc,
  eq,
  getTableColumns,
  gt,
  inArray,
  notInArray,
} from "drizzle-orm";
import type { Effect } from "effect";
import {
  workflowExecutions,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@rova/shared/workflow/execution-contracts";
import { inFlightExecution } from "#src/backend/services/workflows/executions/repo/runs";
import type {
  SettledWaitStatus,
  WorkflowExecution,
  WorkflowWaitState,
} from "#src/backend/services/workflows/executions/repo/contracts";

/** The `workflow_wait_states` slice of `ExecutionRepo`. */
export type WaitsRepoMethods = {
  /**
   * Park a run on a wait, answering the new row's id.
   *
   * The status flip runs first, behind the in-flight guard: a policy cancel can
   * land between the run's last step and this park, and a cancelled execution
   * must not gain a live wait row that resume matching would later hit.
   * Undefined is that race lost -- the caller's run is already being cancelled.
   */
  readonly startWait: (input: {
    executionId: string;
    workflowId: string;
    runId: string;
    nodeId: string;
    nodeName: string;
    waitType: "delay" | "event";
    resumeToken?: string;
    waitUntil?: Date;
    /** The Event names a delivery finds this row by. Empty for a wait on a clock. */
    subscribedEvents?: string[];
    metadata?: Record<string, unknown>;
  }) => Effect.Effect<{ waitStateId: string } | undefined, DatabaseError>;
  /**
   * Close out one wait row, answering whether it was still waiting. Guarded on
   * `waiting`, so a wait that already resumed is left alone.
   */
  readonly markWaitStatus: (input: {
    waitStateId: string;
    status: SettledWaitStatus;
  }) => Effect.Effect<boolean, DatabaseError>;
  /** Cancel whichever of these wait rows are still waiting, answering which. */
  readonly cancelWaits: (
    waitStateIds: string[]
  ) => Effect.Effect<string[], DatabaseError>;
  /**
   * One page of the runs of this workflow parked on this Event name, whatever
   * they are waiting for the payload to say.
   *
   * The name narrows the candidates and the stored match decides between them,
   * so this answers a question about subscription rather than about entity: a
   * run parked on an Event its workflow never starts on is found here, which is
   * the whole point of a Wait Subscription being independent of the Lifecycle
   * Rules.
   *
   * Paged by id because nothing bounds the parked population -- an event wait
   * defaults to a 7-day timeout -- and every row carries the JSONB holding its
   * compiled match. The caller walks the pages; `afterId` is the last id it saw.
   *
   * The execution-status filter on the join makes reads self-healing: a wait
   * row orphaned by a partially failed cancellation (execution already
   * terminal, wait still `waiting`) never re-enters resume matching, where it
   * would silently consume a real Event against a dead run.
   */
  readonly listWaitsForEvent: (input: {
    workflowId: string;
    eventName: string;
    runMode: WorkflowExecution["runMode"];
    limit: number;
    afterId?: string;
    /** Runs this delivery already settled, filtered in SQL rather than after. */
    excludingExecutionIds?: string[];
  }) => Effect.Effect<WorkflowWaitState[], DatabaseError>;
  /**
   * The waiting node one resume token addresses, or null when the token names
   * no wait or one that has already moved on. Status is part of the question
   * rather than of the answer, since a resumed wait and an absent one are the
   * same "no longer active" to the caller.
   */
  readonly findWaitingStateByToken: (
    resumeToken: string
  ) => Effect.Effect<WorkflowWaitState | null, DatabaseError>;
  /** Every wait one run is currently parked on, for the runs panel. */
  readonly listWaitingStates: (
    executionId: string
  ) => Effect.Effect<WorkflowWaitState[], DatabaseError>;
  /**
   * The same question asked of a set of runs at once, grouped by run.
   *
   * A cancellation claims every in-flight run of one entity in one statement,
   * and asking each claimed run for its parked waits separately is that set
   * taken apart again. Runs with nothing parked are absent from the map.
   */
  readonly listWaitingStatesForExecutions: (
    executionIds: string[]
  ) => Effect.Effect<Map<string, WorkflowWaitState[]>, DatabaseError>;
};

/** Builds the `workflow_wait_states` slice of `ExecutionRepo` over one database. */
export function makeWaitsMethods(
  database: Database["Service"]
): WaitsRepoMethods {
  return {
    startWait: (input) =>
      database.query(async (db) => {
        const parked = await db
          .update(workflowExecutions)
          .set({ status: "waiting", waitingAt: new Date() })
          .where(inFlightExecution(input.executionId))
          .returning({ id: workflowExecutions.id });

        if (parked.length === 0) {
          return undefined;
        }

        const [waitState] = await db
          .insert(workflowWaitStates)
          .values({
            executionId: input.executionId,
            workflowId: input.workflowId,
            runId: input.runId,
            nodeId: input.nodeId,
            nodeName: input.nodeName,
            waitType: input.waitType,
            status: "waiting",
            resumeToken: input.resumeToken,
            waitUntil: input.waitUntil,
            subscribedEvents: input.subscribedEvents ?? [],
            metadata: input.metadata,
          })
          .returning({ id: workflowWaitStates.id });

        return { waitStateId: waitState.id };
      }),

    markWaitStatus: (input) =>
      database.query(async (db) => {
        const now = new Date();
        const settled = await db
          .update(workflowWaitStates)
          .set({
            status: input.status,
            resumedAt: input.status === "cancelled" ? null : now,
            cancelledAt: input.status === "cancelled" ? now : null,
          })
          .where(
            and(
              eq(workflowWaitStates.id, input.waitStateId),
              eq(workflowWaitStates.status, "waiting")
            )
          )
          .returning({ id: workflowWaitStates.id });

        return settled.length > 0;
      }),

    cancelWaits: (waitStateIds) =>
      database.query(async (db) => {
        if (waitStateIds.length === 0) {
          return [];
        }

        const cancelled = await db
          .update(workflowWaitStates)
          .set({ status: "cancelled", cancelledAt: new Date() })
          .where(
            and(
              inArray(workflowWaitStates.id, waitStateIds),
              eq(workflowWaitStates.status, "waiting")
            )
          )
          .returning({ id: workflowWaitStates.id });

        return cancelled.map((row) => row.id);
      }),

    listWaitsForEvent: (input) =>
      database.query((db) =>
        db
          .select(getTableColumns(workflowWaitStates))
          .from(workflowWaitStates)
          .innerJoin(
            workflowExecutions,
            eq(workflowWaitStates.executionId, workflowExecutions.id)
          )
          .where(
            and(
              eq(workflowWaitStates.workflowId, input.workflowId),
              // The GIN index over this column is what the containment test
              // rides on; the partial btree on `workflow_id` is what narrows the
              // posting list to this workflow before the recheck.
              arrayContains(workflowWaitStates.subscribedEvents, [
                input.eventName,
              ]),
              eq(workflowWaitStates.status, "waiting"),
              eq(workflowExecutions.runMode, input.runMode),
              inArray(workflowExecutions.status, [
                ...IN_FLIGHT_EXECUTION_STATUSES,
              ]),
              input.afterId
                ? gt(workflowWaitStates.id, input.afterId)
                : undefined,
              input.excludingExecutionIds?.length
                ? notInArray(
                    workflowWaitStates.executionId,
                    input.excludingExecutionIds
                  )
                : undefined
            )
          )
          .orderBy(asc(workflowWaitStates.id))
          .limit(input.limit)
      ),

    findWaitingStateByToken: (resumeToken) =>
      database.query(async (db) => {
        const waitState = await db.query.workflowWaitStates.findFirst({
          where: and(
            eq(workflowWaitStates.resumeToken, resumeToken),
            eq(workflowWaitStates.status, "waiting")
          ),
        });

        return waitState ?? null;
      }),

    listWaitingStates: (executionId) =>
      database.query((db) =>
        db.query.workflowWaitStates.findMany({
          where: and(
            eq(workflowWaitStates.executionId, executionId),
            eq(workflowWaitStates.status, "waiting")
          ),
        })
      ),

    listWaitingStatesForExecutions: (executionIds) =>
      database.query(async (db) => {
        const byExecution = new Map<string, WorkflowWaitState[]>();
        if (executionIds.length === 0) {
          return byExecution;
        }

        const rows = await db.query.workflowWaitStates.findMany({
          where: and(
            inArray(workflowWaitStates.executionId, executionIds),
            eq(workflowWaitStates.status, "waiting")
          ),
        });

        for (const row of rows) {
          const existing = byExecution.get(row.executionId);
          if (existing) {
            existing.push(row);
            continue;
          }
          byExecution.set(row.executionId, [row]);
        }

        return byExecution;
      }),
  };
}
