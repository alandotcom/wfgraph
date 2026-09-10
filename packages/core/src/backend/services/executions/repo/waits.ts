import {
  and,
  arrayContains,
  asc,
  eq,
  exists,
  getColumns,
  gt,
  inArray,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Effect } from "effect";
import {
  workflowExecutions,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type { WfGraphDatabase } from "#src/backend/lib/db/index";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  type JsonObject,
  type JsonObjectDraft,
  toJsonObject,
} from "@wfgraph/shared/types/json";
import type { WaitSignalType } from "@wfgraph/shared/lifecycle/wait-signal";
import { inFlightExecution } from "#src/backend/services/executions/repo/runs";
import type {
  SettledWaitStatus,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo/contracts";

const WAIT_RESUME_CLAIM_LEASE_MS = 5 * 60 * 1000;

export type WaitResumeClaim = {
  waitState: WorkflowWaitState;
  claimedAt: Date;
};

/**
 * The metadata key a resume claim writes its wake under, which the engine reads
 * back when a re-park finds the row has left `waiting`.
 */
export const WAIT_ARRIVAL_METADATA_KEY = "arrival";

/**
 * What a claim is about, written onto the row in the same statement that claims
 * it.
 *
 * A run woken by a Migration is still parked as far as the row is concerned
 * until its next park lands, so a claim in that window sends a signal the run
 * is not listening for. Recording the wake on the row is what lets the next
 * park find it.
 */
export type WaitResumeArrival = {
  signalType: WaitSignalType;
  /** The Event that arrived, and null for a resume from the runs panel. */
  eventName: string | null;
  payload: JsonObject;
};

/** The claim's wake as it is stored, under one key of the row's metadata. */
function arrivalMetadata(arrival: WaitResumeArrival): JsonObject {
  return { [WAIT_ARRIVAL_METADATA_KEY]: { ...arrival } };
}

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
    resumeToken?: string | undefined;
    waitUntil?: Date | undefined;
    /** The Event names a delivery finds this row by. Empty for a wait on a clock. */
    subscribedEvents?: string[] | undefined;
    metadata?: JsonObjectDraft | undefined;
  }) => Effect.Effect<{ waitStateId: string } | undefined, DatabaseError>;
  /**
   * Write a re-parked wait's whole park onto the row it is already parked on,
   * answering whether a row still `waiting` was written.
   *
   * A Migration moves an open Execution to a later Workflow Version while it is
   * parked, and the Wait then parks again against the new version's config. The
   * row keeps its id and its `waiting` status, so the delivery fan-out keeps
   * addressing the same park. Everything else is the new version's answer,
   * including the wait type, so a Wait that changed mode re-parks as the mode it
   * now is. False means the row left `waiting` while the run was between parks.
   */
  readonly reparkWait: (input: {
    waitStateId: string;
    waitType: "delay" | "event";
    waitUntil: Date | null;
    subscribedEvents: string[];
    resumeToken: string | null;
    metadata: JsonObject;
  }) => Effect.Effect<boolean, DatabaseError>;
  /** One wait row by id, whatever status it is in. */
  readonly findWaitStateById: (
    waitStateId: string
  ) => Effect.Effect<WorkflowWaitState | null, DatabaseError>;
  /**
   * Close out one wait row, answering whether it was still active. A normal
   * resume starts from `waiting`; timeout and cancellation may also overtake an
   * in-flight resume claim. Only the fenced claim method can settle `resuming`
   * as successfully resumed.
   */
  readonly markWaitStatus: (input: {
    waitStateId: string;
    status: SettledWaitStatus;
  }) => Effect.Effect<boolean, DatabaseError>;
  /** Cancel whichever rows are waiting or being resumed, answering which. */
  readonly cancelWaits: (
    waitStateIds: string[]
  ) => Effect.Effect<string[], DatabaseError>;
  /**
   * Cancel every active wait of one run, including an in-flight resume claim.
   *
   * For the rows a killed branch run left behind, whose ids nobody holds: the
   * branch parked and was then stopped where it stood.
   */
  readonly cancelWaitsForExecution: (
    executionId: string
  ) => Effect.Effect<void, DatabaseError>;
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
   * Candidate selection spans execution modes. Published live runs and draft
   * test runs can coexist for one workflow, and each parked row keeps the Event
   * subscription its own run requested.
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
    limit: number;
    afterId?: string | undefined;
    /** Runs this delivery already settled, filtered in SQL rather than after. */
    excludingExecutionIds?: string[] | undefined;
  }) => Effect.Effect<WorkflowWaitState[], DatabaseError>;
  /**
   * Claim the waiting node one resume token addresses. The guarded update is
   * the concurrency boundary: exactly one caller gets the row. An abandoned
   * in-flight claim becomes reclaimable after its lease rather than consuming
   * the wait forever.
   */
  readonly claimWaitingStateByToken: (input: {
    resumeToken: string;
    arrival: WaitResumeArrival;
  }) => Effect.Effect<WaitResumeClaim | null, DatabaseError>;
  /**
   * Claim one candidate previously found by event delivery. The execution may
   * already be running because a sibling wait resumed first.
   */
  readonly claimWaitingStateById: (input: {
    waitStateId: string;
    arrival: WaitResumeArrival;
  }) => Effect.Effect<WaitResumeClaim | null, DatabaseError>;
  /** Settle only the exact claim that delivered the wake signal. */
  readonly settleWaitingStateClaim: (input: {
    waitStateId: string;
    claimedAt: Date;
  }) => Effect.Effect<boolean, DatabaseError>;
  /** Restore a claimed wait when its wake signal was refused before delivery. */
  readonly releaseWaitingStateClaim: (input: {
    waitStateId: string;
    claimedAt: Date;
  }) => Effect.Effect<boolean, DatabaseError>;
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
      database.query((db) =>
        db.transaction(async (tx) => {
          const parked = await tx
            .update(workflowExecutions)
            .set({ status: "waiting", waitingAt: new Date() })
            .where(inFlightExecution(input.executionId))
            .returning({ id: workflowExecutions.id });

          if (parked.length === 0) {
            return undefined;
          }

          const [waitState] = await tx
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
              metadata: toJsonObject(input.metadata),
            })
            .returning({ id: workflowWaitStates.id });

          return { waitStateId: waitState.id };
        })
      ),

    reparkWait: (input) =>
      database.query(async (db) => {
        const reparked = await db
          .update(workflowWaitStates)
          .set({
            waitType: input.waitType,
            waitUntil: input.waitUntil,
            subscribedEvents: input.subscribedEvents,
            resumeToken: input.resumeToken,
            metadata: input.metadata,
          })
          .where(
            and(
              eq(workflowWaitStates.id, input.waitStateId),
              eq(workflowWaitStates.status, "waiting")
            )
          )
          .returning({ id: workflowWaitStates.id });

        return reparked.length > 0;
      }),

    findWaitStateById: (waitStateId) =>
      database.query(async (db) => {
        const [row] = await db
          .select()
          .from(workflowWaitStates)
          .where(eq(workflowWaitStates.id, waitStateId))
          .limit(1);
        return row ?? null;
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
              input.status === "resumed"
                ? eq(workflowWaitStates.status, "waiting")
                : inArray(workflowWaitStates.status, ["waiting", "resuming"])
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
              inArray(workflowWaitStates.status, ["waiting", "resuming"])
            )
          )
          .returning({ id: workflowWaitStates.id });

        return cancelled.map((row) => row.id);
      }),

    cancelWaitsForExecution: (executionId) =>
      database.query(async (db) => {
        await db
          .update(workflowWaitStates)
          .set({ status: "cancelled", cancelledAt: new Date() })
          .where(
            and(
              eq(workflowWaitStates.executionId, executionId),
              inArray(workflowWaitStates.status, ["waiting", "resuming"])
            )
          );
      }),

    listWaitsForEvent: (input) =>
      database.query((db) =>
        db
          .select(getColumns(workflowWaitStates))
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

    claimWaitingStateByToken: (input) =>
      database.query((db) =>
        claimWaitState(
          db,
          eq(workflowWaitStates.resumeToken, input.resumeToken),
          input.arrival
        )
      ),

    claimWaitingStateById: (input) =>
      database.query((db) =>
        claimWaitState(
          db,
          eq(workflowWaitStates.id, input.waitStateId),
          input.arrival
        )
      ),

    settleWaitingStateClaim: (input) =>
      database.query(async (db) => {
        const settled = await db
          .update(workflowWaitStates)
          .set({ status: "resumed", resumedAt: new Date() })
          .where(
            and(
              eq(workflowWaitStates.id, input.waitStateId),
              eq(workflowWaitStates.status, "resuming"),
              eq(workflowWaitStates.resumedAt, input.claimedAt)
            )
          )
          .returning({ id: workflowWaitStates.id });

        return settled.length > 0;
      }),

    releaseWaitingStateClaim: (input) =>
      database.query(async (db) => {
        const released = await db
          .update(workflowWaitStates)
          .set({ status: "waiting", resumedAt: null })
          .where(
            and(
              eq(workflowWaitStates.id, input.waitStateId),
              eq(workflowWaitStates.status, "resuming"),
              eq(workflowWaitStates.resumedAt, input.claimedAt)
            )
          )
          .returning({ id: workflowWaitStates.id });

        return released.length > 0;
      }),

    listWaitingStates: (executionId) =>
      database.query((db) =>
        db.query.workflowWaitStates.findMany({
          where: {
            executionId,
            status: "waiting",
          },
        })
      ),

    listWaitingStatesForExecutions: (executionIds) =>
      database.query(async (db) => {
        const byExecution = new Map<string, WorkflowWaitState[]>();
        if (executionIds.length === 0) {
          return byExecution;
        }

        const rows = await db.query.workflowWaitStates.findMany({
          where: {
            executionId: { in: executionIds },
            status: "waiting",
          },
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

/**
 * Claims one row and records the wake in the same statement.
 *
 * The wake is merged into the metadata the park wrote rather than replacing it,
 * so the compiled match the row carries survives a claim.
 */
async function claimWaitState(
  db: WfGraphDatabase,
  identity: ReturnType<typeof eq>,
  arrival: WaitResumeArrival
): Promise<WaitResumeClaim | null> {
  const claimedAt = new Date();
  const staleBefore = new Date(
    claimedAt.getTime() - WAIT_RESUME_CLAIM_LEASE_MS
  );
  const [waitState] = await db
    .update(workflowWaitStates)
    .set({
      status: "resuming",
      resumedAt: claimedAt,
      metadata: sql`coalesce(${workflowWaitStates.metadata}, '{}'::jsonb) || ${JSON.stringify(arrivalMetadata(arrival))}::jsonb`,
    })
    .where(
      and(
        identity,
        or(
          eq(workflowWaitStates.status, "waiting"),
          and(
            eq(workflowWaitStates.status, "resuming"),
            lte(workflowWaitStates.resumedAt, staleBefore)
          )
        ),
        exists(
          db
            .select({ id: workflowExecutions.id })
            .from(workflowExecutions)
            .where(
              and(
                eq(workflowExecutions.id, workflowWaitStates.executionId),
                inArray(workflowExecutions.status, [
                  ...IN_FLIGHT_EXECUTION_STATUSES,
                ])
              )
            )
        )
      )
    )
    .returning();

  return waitState ? { waitState, claimedAt } : null;
}
