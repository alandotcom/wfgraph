/**
 * The `workflow_executions` slice of `ExecutionRepo`.
 *
 * A Cancel claim is a routed continuation rather than an ending, so a write that
 * names `side: "canceled"` reaches a Cancel-claimed row. Every other guard here
 * still requires an unclaimed row, and an Exit claim reaches no side at all.
 */

import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Effect } from "effect";
import {
  workflowExecutions,
  workflows,
  workflowVersions,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type {
  WfGraphDatabase,
  WfGraphTransaction,
} from "#src/backend/lib/db/index";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import {
  lockSchedules,
  settleEndedExecutions,
} from "#src/backend/services/executions/repo/schedule";
import type { RunScopedAuditEventType } from "@wfgraph/shared/lifecycle/audit-event-types";
import {
  IN_FLIGHT_EXECUTION_STATUSES,
  isoTerminationClaim,
  type EntityEligibilityReason,
  type ExecutionSide,
  type TerminalExecutionStatus,
  type TerminationKind,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import type {
  JsonObject,
  JsonObjectDraft,
  JsonValue,
} from "@wfgraph/shared/types/json";
import {
  recordAuditEventsWrite,
  recordAuditEventWrite,
} from "#src/backend/services/executions/repo/audit";
import {
  decideRunEnd,
  type OutsideGraphEnding,
  type RunEnding,
  type RunVerdict,
} from "@wfgraph/shared/lifecycle/run-ending";
import type {
  StoreWrite,
  ExecutionPageQuery,
  ExecutionStatusRow,
  ExecutionSummary,
  ExecutionTerminationState,
  GlobalExecutionRow,
  InFlightExecutionRow,
  NewTerminalExecution,
  PendingCancel,
  WorkflowExecution,
  WorkflowExecutionListRow,
} from "#src/backend/services/executions/repo/contracts";

/**
 * The columns both run-list queries select, plus the two they join for.
 *
 * JSONB payloads and the routing columns the lists never paint stay off this
 * list, so a poll does not pull TOAST the panel would discard. `versionKind` and
 * `versionNumber` come from the version the run pinned, looked up by primary
 * key, so the panel can label a run's graph without reading the graph.
 */
const EXECUTION_LIST_COLUMNS = {
  id: workflowExecutions.id,
  workflowId: workflowExecutions.workflowId,
  status: workflowExecutions.status,
  startSource: workflowExecutions.startSource,
  runMode: workflowExecutions.runMode,
  startEventName: workflowExecutions.startEventName,
  entityValue: workflowExecutions.entityValue,
  versionKind: workflowVersions.kind,
  versionNumber: workflowVersions.version,
  error: workflowExecutions.error,
  startedAt: workflowExecutions.startedAt,
  scheduledFor: workflowExecutions.scheduledFor,
  scheduleCron: workflowExecutions.scheduleCron,
  scheduleTimeZone: workflowExecutions.scheduleTimeZone,
  waitingAt: workflowExecutions.waitingAt,
  cancelledAt: workflowExecutions.cancelledAt,
  completedAt: workflowExecutions.completedAt,
  duration: workflowExecutions.duration,
} as const satisfies Record<keyof WorkflowExecutionListRow, PgColumn>;

/** Join condition for the pinned version. Every execution pins exactly one. */
const pinnedVersion = eq(
  workflowExecutions.workflowVersionId,
  workflowVersions.id
);

type Executor = WfGraphDatabase | WfGraphTransaction;

/** The most recent runs one workflow's panel shows. */
const WORKFLOW_EXECUTIONS_LIMIT = 50;

/**
 * `claimKindAdmits` as a condition on the execution row, which is where every
 * guarded write asks it.
 */
export function claimAdmits(side: ExecutionSide): SQL {
  return side === "canceled"
    ? eq(workflowExecutions.terminationKind, "cancel")
    : isNull(workflowExecutions.terminationKind);
}

/**
 * The guard a write carries when it serves both sides and cannot say which one
 * it is for: whatever either side admits, which is every claim but an Exit.
 *
 * Claiming a wait row and re-parking a run behind a sibling's open wait are both
 * about whichever side parked that row, and no row records the side.
 *
 * Written as one `sql` chunk because drizzle's `or` answers `SQL | undefined`
 * for any argument list, and a guard this is always part of should not be
 * optional at its call sites.
 */
export const notExitClaimed: SQL = sql`(${claimAdmits("started")} or ${claimAdmits("canceled")})`;

/**
 * The compare-and-set every write that ends or parks a run from outside it
 * carries: the run has not reached a verdict, and its claim admits this side.
 *
 * Shared with `waits.ts`, whose `startWait` parks a run behind the same guard.
 */
export function inFlightExecution(
  executionId: string,
  side: ExecutionSide
): SQL | undefined {
  return and(
    eq(workflowExecutions.id, executionId),
    inArray(workflowExecutions.status, [...IN_FLIGHT_EXECUTION_STATUSES]),
    claimAdmits(side)
  );
}

const TERMINATION_COLUMNS = {
  executionId: workflowExecutions.id,
  status: workflowExecutions.status,
  kind: workflowExecutions.terminationKind,
  requestedAt: workflowExecutions.terminationRequestedAt,
  reason: workflowExecutions.terminationReason,
  nodeId: workflowExecutions.terminationNodeId,
  eventName: workflowExecutions.cancelEventName,
  payload: workflowExecutions.cancelPayload,
} as const;

type TerminationRow = {
  executionId: string;
  status: WorkflowExecution["status"];
  kind: TerminationKind | null;
  requestedAt: Date | null;
  reason: EntityEligibilityReason | null;
  nodeId: string | null;
  eventName: string | null;
  payload: JsonObject | null;
};

function executionTerminationState(
  row: TerminationRow,
  didWrite = false
): ExecutionTerminationState {
  if (row.kind === null) {
    return {
      executionId: row.executionId,
      status: row.status,
      claim: null,
      didWrite,
    };
  }
  if (row.requestedAt === null) {
    throw new Error("Execution termination claim has no timestamp");
  }
  if (row.kind === "cancel") {
    return {
      executionId: row.executionId,
      status: row.status,
      claim: {
        kind: "cancel",
        requestedAt: row.requestedAt,
        eventName: row.eventName,
        payload: row.payload,
      },
      didWrite,
    };
  }
  if (row.reason === null || row.nodeId === null) {
    throw new Error("Execution exit claim is incomplete");
  }
  return {
    executionId: row.executionId,
    status: row.status,
    claim: {
      kind: "exit",
      requestedAt: row.requestedAt,
      reason: row.reason,
      nodeId: row.nodeId,
    },
    didWrite,
  };
}

function buildPageFilters(query: ExecutionPageQuery): SQL[] {
  const filters: SQL[] = [];

  if (query.workflowIds && query.workflowIds.length > 0) {
    filters.push(inArray(workflowExecutions.workflowId, query.workflowIds));
  }

  if (query.statuses && query.statuses.length > 0) {
    filters.push(inArray(workflowExecutions.status, query.statuses));
  }

  if (query.cursor) {
    // Ordering is by start time and then id, so resuming after a row means
    // everything older, plus the ties that sort below it.
    const cursorFilter = or(
      lt(workflowExecutions.startedAt, query.cursor.startedAt),
      and(
        eq(workflowExecutions.startedAt, query.cursor.startedAt),
        lt(workflowExecutions.id, query.cursor.id)
      )
    );
    if (cursorFilter) {
      filters.push(cursorFilter);
    }
  }

  return filters;
}

/**
 * The timeline entry saying how a run ended, which the write that ends it
 * inserts with its row.
 */
type RunEndingAnnouncement<EventType extends RunScopedAuditEventType> = {
  workflowId: string;
  eventType: EventType;
  message: string;
  metadata?: JsonObjectDraft | undefined;
};

/** The `workflow_executions` slice of `ExecutionRepo`. */
export type RunsRepoMethods = {
  /**
   * One workflow's most recent runs, newest first.
   *
   * Superseded runs are left out unless asked for: a newest-wins workflow
   * supersedes a run on every reschedule, and those rows would crowd the ones
   * the panel was opened for out of the row cap. The panel's toggle is what
   * asks, and `countSuperseded` is what labels it.
   */
  readonly listByWorkflow: (input: {
    workflowId: string;
    includeSuperseded: boolean;
  }) => Effect.Effect<WorkflowExecutionListRow[], DatabaseError>;
  /** How many runs of this workflow a newer start displaced. */
  readonly countSuperseded: (
    workflowId: string
  ) => Effect.Effect<number, DatabaseError>;
  /**
   * One page of runs across every workflow, newest first, each row carrying
   * the name and paused flag of the workflow it belongs to.
   */
  readonly listPage: (
    query: ExecutionPageQuery
  ) => Effect.Effect<GlobalExecutionRow[], DatabaseError>;
  /**
   * Every in-flight run of one workflow, in the columns a Migration classifies
   * from.
   *
   * Unpaged, because a Migration's verdict is about the whole set: the report
   * counts the runs already on the target version beside the ones it can move,
   * and a page boundary would split that count.
   */
  readonly listInFlightByWorkflow: (
    workflowId: string
  ) => Effect.Effect<InFlightExecutionRow[], DatabaseError>;
  /** One run as the logs view paints it (status, timing, and start identity). */
  readonly findSummaryById: (
    executionId: string
  ) => Effect.Effect<ExecutionSummary | null, DatabaseError>;
  /** Where one run got to, the smallest answer the status poll can be given. */
  readonly findStatusById: (
    executionId: string
  ) => Effect.Effect<ExecutionStatusRow | null, DatabaseError>;
  /** Whether the run is there at all, for the paths that only report absence. */
  readonly existsById: (
    executionId: string
  ) => Effect.Effect<boolean, DatabaseError>;
  /**
   * Which workflow a run belongs to, which is all the cancel path needs of the
   * run itself before it starts writing audit rows against the workflow.
   */
  readonly findWorkflowIdById: (
    executionId: string
  ) => Effect.Effect<string | null, DatabaseError>;
  /**
   * The Execution one Event delivery opened in one workflow, or `null` when the
   * delivery opened none. The unique index is on `(workflowId, deliveryId)`, so
   * the pair names at most one row. A delivery retry reads this to find the run
   * an earlier attempt committed.
   */
  readonly findByDelivery: (input: {
    workflowId: string;
    deliveryId: string;
  }) => Effect.Effect<WorkflowExecution | null, DatabaseError>;
  /**
   * Record a run that never started, already in its terminal status, with
   * `announcement` on its timeline in the same transaction. The entry is
   * written for the inserted row's workflow.
   */
  readonly insertTerminal: (
    input: NewTerminalExecution & {
      announcement: Omit<
        RunEndingAnnouncement<
          "run_completed" | "run_failed" | "run_cancelled" | "run_ignored"
        >,
        "workflowId"
      >;
    }
  ) => Effect.Effect<WorkflowExecution, DatabaseError>;
  /**
   * Move a run back from "waiting" to "running" under the version the caller
   * loaded, answering whether a row moved.
   *
   * The version is the fence a resuming Wait relies on: a Migration that lands
   * between the wake and this write leaves the row pinned to another version,
   * no row is written, and the caller starts again against the new pointer.
   *
   * Only `waiting` and `running` are accepted starting statuses. `waiting` is
   * the run this resume woke. `running` is a sibling Wait of the same run having
   * already written it, which is routine when two branches wake together. A
   * `pending` run has not reached a Wait, so a resume finding one is addressing
   * a row nothing parked.
   */
  readonly markRunning: StoreWrite<
    {
      executionId: string;
      workflowVersionId: string;
      /** Which side of the Lifecycle Node the resuming Wait sits on. */
      side: ExecutionSide;
    },
    boolean
  >;
  /**
   * Move a `running` run back to `waiting` when it still holds a waiting wait
   * row, answering whether a row moved.
   *
   * Only a park writes `waiting`, so a run whose branch resumed and finished
   * while a sibling branch stayed parked would read `running` until that sibling
   * woke. The guard is what keeps this from parking a run with nothing left
   * waiting: the wait-row test and the status test are one statement, so a park
   * or a resume landing beside it cannot be overtaken.
   */
  readonly markWaitingIfParked: StoreWrite<{ executionId: string }, boolean>;
  /**
   * Stops a run from outside it: an operator, a Cancel Event or a Lifecycle
   * Rule. Answers the run's state, `didWrite` saying whether this write ended
   * it, or null when the row is absent.
   *
   * A run that already ended, or that holds a Cancel or Exit claim its own pass
   * will finalize, is left as it was (`decideRunEnd`). The write that ends the
   * run stamps `cancelledAt`, writes its `run_cancelled` entry, cancels its
   * open wait rows and deletes its schedule row and step memo, so a pass
   * holding its lease is refused at its next fenced write.
   */
  readonly cancelRun: (input: {
    executionId: string;
    reason: string;
    eventName?: string | undefined;
  }) => Effect.Effect<ExecutionTerminationState | null, DatabaseError>;
  /**
   * Atomically claims an execution-wide Entity Eligibility exit and returns the
   * authoritative stored boundary, including an earlier competing outcome.
   */
  readonly requestExit: StoreWrite<
    {
      executionId: string;
      reason: EntityEligibilityReason;
      nodeId: string;
      requestedAt?: Date | undefined;
    },
    ExecutionTerminationState | null
  >;
  /**
   * Linearizes one node admission before or after an execution-wide claim.
   * True means the node was admitted while the run was still in flight and
   * unclaimed; a later claim may stop its successors but not undo this answer.
   */
  readonly canAdmitNode: (
    executionId: string
  ) => Effect.Effect<boolean, DatabaseError>;
  /** The authoritative boundary state, or null when the execution is absent. */
  readonly findTerminationState: (
    executionId: string
  ) => Effect.Effect<ExecutionTerminationState | null, DatabaseError>;
  /** The cancel a run was flagged with, or null when it carries none. */
  readonly findPendingCancel: (
    executionId: string
  ) => Effect.Effect<PendingCancel | null, DatabaseError>;
  /**
   * Ends the run from inside it: the engine's verdict, or the executor ending
   * a run it could not walk. Answers the run's state, `didWrite` saying
   * whether this write ended it, or null when the row is absent.
   *
   * `decideRunEnd` picks the status from the run's claim, read under the
   * write's lock, so a claim cannot land between the decision and the write.
   * A verdict a Cancel claim refuses leaves the run in flight for the engine to
   * run the Canceled outlet. The write that ends the run writes its timeline
   * entry and settles its wait rows, schedule row and step memo.
   */
  readonly endRun: StoreWrite<
    {
      executionId: string;
      ending: RunVerdict | OutsideGraphEnding;
      /** What the run answers with, which a verdict that ends it writes. */
      output?: JsonValue | undefined;
    },
    ExecutionTerminationState | null
  >;
};

/** Builds the `workflow_executions` slice of `ExecutionRepo` over one database. */
export function makeRunsMethods(
  database: Database["Service"]
): RunsRepoMethods {
  return {
    listByWorkflow: ({ workflowId, includeSuperseded }) =>
      database.query((db) =>
        db
          .select(EXECUTION_LIST_COLUMNS)
          .from(workflowExecutions)
          .innerJoin(workflowVersions, pinnedVersion)
          .where(
            and(
              eq(workflowExecutions.workflowId, workflowId),
              includeSuperseded
                ? undefined
                : ne(workflowExecutions.status, "superseded")
            )
          )
          .orderBy(desc(workflowExecutions.startedAt))
          .limit(WORKFLOW_EXECUTIONS_LIMIT)
      ),

    countSuperseded: (workflowId) =>
      database.query(async (db) => {
        const [row] = await db
          .select({ total: count() })
          .from(workflowExecutions)
          .where(
            and(
              eq(workflowExecutions.workflowId, workflowId),
              eq(workflowExecutions.status, "superseded")
            )
          );

        return row?.total ?? 0;
      }),

    listPage: (query) =>
      database.query((db) => {
        const filters = buildPageFilters(query);

        return db
          .select({
            ...EXECUTION_LIST_COLUMNS,
            workflowName: workflows.name,
            workflowIsPaused: workflows.isPaused,
          })
          .from(workflowExecutions)
          .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
          .innerJoin(workflowVersions, pinnedVersion)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(
            desc(workflowExecutions.startedAt),
            desc(workflowExecutions.id)
          )
          .limit(query.limit);
      }),

    listInFlightByWorkflow: (workflowId) =>
      database.query((db) =>
        db
          .select({
            id: workflowExecutions.id,
            status: workflowExecutions.status,
            workflowVersionId: workflowExecutions.workflowVersionId,
            versionKind: workflowVersions.kind,
            versionNumber: workflowVersions.version,
            entityType: workflowExecutions.entityType,
            entityId: workflowExecutions.entityId,
          })
          .from(workflowExecutions)
          .innerJoin(workflowVersions, pinnedVersion)
          .where(
            and(
              eq(workflowExecutions.workflowId, workflowId),
              inArray(workflowExecutions.status, [
                ...IN_FLIGHT_EXECUTION_STATUSES,
              ]),
              isNull(workflowExecutions.terminationKind)
            )
          )
          .orderBy(
            desc(workflowExecutions.startedAt),
            desc(workflowExecutions.id)
          )
      ),

    findSummaryById: (executionId) =>
      database.query(async (db) => {
        const [execution] = await db
          .select({
            id: workflowExecutions.id,
            workflowId: workflowExecutions.workflowId,
            workflowVersionId: workflowExecutions.workflowVersionId,
            versionKind: workflowVersions.kind,
            versionNumber: workflowVersions.version,
            status: workflowExecutions.status,
            startSource: workflowExecutions.startSource,
            runMode: workflowExecutions.runMode,
            startEventName: workflowExecutions.startEventName,
            entityValue: workflowExecutions.entityValue,
            entityType: workflowExecutions.entityType,
            entityId: workflowExecutions.entityId,
            input: workflowExecutions.input,
            output: workflowExecutions.output,
            error: workflowExecutions.error,
            startedAt: workflowExecutions.startedAt,
            scheduledFor: workflowExecutions.scheduledFor,
            scheduleCron: workflowExecutions.scheduleCron,
            scheduleTimeZone: workflowExecutions.scheduleTimeZone,
            completedAt: workflowExecutions.completedAt,
            duration: workflowExecutions.duration,
          })
          .from(workflowExecutions)
          .innerJoin(workflowVersions, pinnedVersion)
          .where(eq(workflowExecutions.id, executionId))
          .limit(1);

        return execution ?? null;
      }),

    findStatusById: (executionId) =>
      database.query(async (db) => {
        const execution = await db.query.workflowExecutions.findFirst({
          where: { id: executionId },
          columns: { id: true, status: true },
        });

        return execution ?? null;
      }),

    existsById: (executionId) =>
      database.query(async (db) => {
        const execution = await db.query.workflowExecutions.findFirst({
          where: { id: executionId },
          columns: { id: true },
        });

        return execution !== undefined;
      }),

    findWorkflowIdById: (executionId) =>
      database.query(async (db) => {
        const execution = await db.query.workflowExecutions.findFirst({
          where: { id: executionId },
          columns: { workflowId: true },
        });

        return execution?.workflowId ?? null;
      }),

    findByDelivery: (input) =>
      database.query(async (db) => {
        const execution = await db.query.workflowExecutions.findFirst({
          where: { workflowId: input.workflowId, deliveryId: input.deliveryId },
        });

        return execution ?? null;
      }),

    insertTerminal: ({ announcement, ...input }) =>
      database.query((db) =>
        db.transaction(async (tx) => {
          const now = new Date();
          const [execution] = await tx
            .insert(workflowExecutions)
            .values({
              workflowId: input.workflowId,
              workflowVersionId: input.workflowVersionId,
              status: input.status,
              startSource: input.startSource,
              runMode: input.runMode,
              startEventName: input.startEventName,
              entityValue: input.entityValue,
              entityType: input.entityType,
              entityId: input.entityId,
              input: input.input,
              output: input.output,
              error: input.error,
              startedAt: now,
              completedAt: now,
              cancelledAt: input.status === "canceled" ? now : null,
              duration: "0",
            })
            .returning();
          await recordAuditEventWrite({
            ...announcement,
            workflowId: input.workflowId,
            executionId: execution.id,
          })(tx);

          return execution;
        })
      ),

    markRunning: (input) => database.query(markRunningWrite(input)),

    markWaitingIfParked: (input) =>
      database.query(markWaitingIfParkedWrite(input)),

    cancelRun: ({ executionId, ...cancel }) =>
      database.query(async (db) => {
        const [state] = await endRunsWrite(db, {
          executionIds: [executionId],
          ending: { kind: "cancel", ...cancel },
        });
        return state ?? null;
      }),

    requestExit: (input) => database.query(requestExitWrite(input)),

    canAdmitNode: (executionId) =>
      database.query(async (db) => {
        const [execution] = await db
          .select({ id: workflowExecutions.id })
          .from(workflowExecutions)
          .where(inFlightExecution(executionId, "started"))
          .limit(1);
        return execution !== undefined;
      }),

    findTerminationState: (executionId) =>
      database.query(async (db) => {
        const [state] = await db
          .select(TERMINATION_COLUMNS)
          .from(workflowExecutions)
          .where(eq(workflowExecutions.id, executionId))
          .limit(1);
        return state ? executionTerminationState(state) : null;
      }),

    findPendingCancel: (executionId) =>
      database.query(async (db) => {
        const execution = await db.query.workflowExecutions.findFirst({
          where: { id: executionId },
          columns: {
            terminationKind: true,
            cancelEventName: true,
            cancelPayload: true,
          },
        });

        if (execution?.terminationKind !== "cancel") {
          return null;
        }

        return {
          eventName: execution.cancelEventName,
          payload: execution.cancelPayload,
        };
      }),

    endRun: (input) => database.query(endRunWrite(input)),
  };
}

type MarkRunningInput = Parameters<RunsRepoMethods["markRunning"]>[0];
type MarkWaitingIfParkedInput = Parameters<
  RunsRepoMethods["markWaitingIfParked"]
>[0];
type RequestExitInput = Parameters<RunsRepoMethods["requestExit"]>[0];
type EndRunInput = Parameters<RunsRepoMethods["endRun"]>[0];

/** The update behind `markRunning`, on whichever handle the caller holds. */
export function markRunningWrite(input: MarkRunningInput) {
  return async (db: Executor): Promise<boolean> => {
    const moved = await db
      .update(workflowExecutions)
      .set({ status: "running", waitingAt: null })
      .where(
        and(
          eq(workflowExecutions.id, input.executionId),
          inArray(workflowExecutions.status, ["waiting", "running"]),
          eq(workflowExecutions.workflowVersionId, input.workflowVersionId),
          claimAdmits(input.side)
        )
      )
      .returning({ id: workflowExecutions.id });

    return moved.length > 0;
  };
}

/** The update behind `markWaitingIfParked`. */
export function markWaitingIfParkedWrite(input: MarkWaitingIfParkedInput) {
  return async (db: Executor): Promise<boolean> => {
    const parked = await db
      .update(workflowExecutions)
      .set({ status: "waiting", waitingAt: new Date() })
      .where(
        and(
          eq(workflowExecutions.id, input.executionId),
          eq(workflowExecutions.status, "running"),
          notExitClaimed,
          exists(
            db
              .select({ id: workflowWaitStates.id })
              .from(workflowWaitStates)
              .where(
                and(
                  eq(workflowWaitStates.executionId, workflowExecutions.id),
                  eq(workflowWaitStates.status, "waiting")
                )
              )
          )
        )
      )
      .returning({ id: workflowExecutions.id });

    return parked.length > 0;
  };
}

/** The update behind `requestExit`. */
export function requestExitWrite(input: RequestExitInput) {
  return async (db: Executor): Promise<ExecutionTerminationState | null> => {
    const [written] = await db
      .update(workflowExecutions)
      .set({
        terminationKind: "exit",
        terminationRequestedAt: input.requestedAt ?? new Date(),
        terminationReason: input.reason,
        terminationNodeId: input.nodeId,
      })
      .where(inFlightExecution(input.executionId, "started"))
      .returning(TERMINATION_COLUMNS);

    return await writtenOrStored(db, input.executionId, written);
  };
}

/**
 * The columns every update that ends a run sets beside its own, so no ended
 * run is missing a completion time or a duration.
 */
function endedRunColumns(status: TerminalExecutionStatus) {
  const now = new Date();
  return {
    status,
    waitingAt: null,
    cancelledAt: status === "canceled" ? now : null,
    completedAt: now,
    // Derived here rather than passed in, because the caller's clock can be
    // the workflow function body, which a durable runtime re-runs on every
    // attempt and after every wait. The row holds when it started, so both
    // ends of the elapsed come from the same place.
    duration: sql<string>`round(extract(epoch from ((now() at time zone 'utc') - ${workflowExecutions.startedAt})) * 1000)::text`,
  };
}

/**
 * A fenced caller holds the schedule row `for update`, because the write
 * deletes it.
 */
export function endRunWrite(input: EndRunInput) {
  return async (db: Executor): Promise<ExecutionTerminationState | null> => {
    const [state] = await endRunsWrite(db, {
      executionIds: [input.executionId],
      ending: input.ending,
      output: input.output,
    });
    return state ?? null;
  };
}

/**
 * The one write that ends runs. In one transaction, a savepoint of a fenced
 * one, it locks the runs' schedule rows and then their execution rows, in the
 * order every fenced write takes them, so no claim lands between the read and
 * the write. `decideRunEnd` decides each run from what was read. Each run it
 * ends gets its terminal columns, written compare-and-set against that read,
 * and one timeline entry, and has its wait rows, schedule row and step memo
 * settled. Answers the state of every named run that exists.
 */
export function endRunsWrite(
  db: Executor,
  input: {
    executionIds: readonly string[];
    ending: RunEnding;
    output?: JsonValue | undefined;
  }
): Promise<ExecutionTerminationState[]> {
  const ids = [...input.executionIds];
  if (ids.length === 0) return Promise.resolve([]);
  return db.transaction(async (tx) => {
    await lockSchedules(tx, ids);
    const runs = await tx
      .select({
        ...TERMINATION_COLUMNS,
        workflowId: workflowExecutions.workflowId,
        runMode: workflowExecutions.runMode,
      })
      .from(workflowExecutions)
      .where(inArray(workflowExecutions.id, ids))
      .orderBy(asc(workflowExecutions.id))
      .for("update");
    const decided = runs.map((run) => {
      const stored = executionTerminationState(run);
      return {
        run,
        stored,
        decision: decideRunEnd(input.ending, {
          status: run.status,
          claim: stored.claim && isoTerminationClaim(stored.claim),
          runMode: run.runMode,
        }),
      };
    });
    for (const { run, decision } of decided) {
      if (decision.kind === "leave") continue;
      // eslint-disable-next-line eslint/no-await-in-loop -- one transaction runs one statement at a time
      const [written] = await tx
        .update(workflowExecutions)
        .set({
          ...endedRunColumns(decision.status),
          output: input.output,
          error: decision.error,
        })
        .where(
          and(
            eq(workflowExecutions.id, run.executionId),
            eq(workflowExecutions.status, run.status),
            run.kind === null
              ? isNull(workflowExecutions.terminationKind)
              : eq(workflowExecutions.terminationKind, run.kind)
          )
        )
        .returning({ id: workflowExecutions.id });
      if (!written) {
        throw new Error("A run changed under the lock its ending holds");
      }
    }
    const ended = decided.flatMap(({ run, decision }) =>
      decision.kind === "write" ? [{ run, decision }] : []
    );
    await recordAuditEventsWrite(
      ended.map(({ run, decision }) => ({
        ...decision.entry,
        workflowId: run.workflowId,
        executionId: run.executionId,
      }))
    )(tx);
    await settleEndedExecutions(
      tx,
      ended.map(({ run }) => run.executionId)
    );
    return decided.map(({ stored, decision }) =>
      decision.kind === "write"
        ? { ...stored, status: decision.status, didWrite: true }
        : stored
    );
  });
}

/**
 * The boundary a guarded write answers: the row it wrote when its guard
 * admitted the row, and otherwise the row as stored, or null when the row is
 * absent.
 */
async function writtenOrStored(
  db: Executor,
  executionId: string,
  written: TerminationRow | undefined
): Promise<ExecutionTerminationState | null> {
  if (written) return executionTerminationState(written, true);
  const [current] = await db
    .select(TERMINATION_COLUMNS)
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);
  return current ? executionTerminationState(current) : null;
}
