/**
 * The `workflow_wait_states` slice of `ExecutionRepo`.
 *
 * A park, a re-park and a resume each name the side of the Lifecycle Node their
 * Wait sits on: a Cancel claim admits the Canceled side and refuses the Started
 * one. An Exit claim refuses both, which is what the claim and listing guards
 * still test, because a wait row does not record which side parked it.
 */

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
  type SQL,
  sql,
} from "drizzle-orm";
import type { Effect } from "effect";
import {
  workflowExecutions,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type { WfGraphDatabase } from "#src/backend/lib/db/index";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import {
  IN_FLIGHT_EXECUTION_STATUSES,
  type ExecutionSide,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  type JsonObject,
  type JsonObjectDraft,
  toJsonObject,
} from "@wfgraph/shared/types/json";
import {
  WAIT_ARRIVAL_METADATA_KEY,
  type WaitArrival,
} from "@wfgraph/shared/lifecycle/wait-signal";
import {
  claimAdmits,
  inFlightExecution,
  notExitClaimed,
} from "#src/backend/services/executions/repo/runs";
import type {
  SettledWaitStatus,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo/contracts";

const WAIT_RESUME_CLAIM_LEASE_MS = 5 * 60 * 1000;

export type WaitResumeClaim = {
  waitState: WorkflowWaitState;
  claimedAt: Date;
};

/** The claim's wake as it is stored, under one key of the row's metadata. */
function arrivalMetadata(arrival: WaitArrival): JsonObject {
  return { [WAIT_ARRIVAL_METADATA_KEY]: { ...arrival } };
}

/**
 * Why a re-park wrote no row.
 *
 * `not_waiting` is the row having left `waiting` between the wake and this park,
 * which the caller answers by reading the wake the row records. `version_moved`
 * is a Migration having moved the execution off the version the park was
 * resolved from, which the caller answers by failing its step and preparing the
 * Wait again against the version the row now names.
 */
export type ReparkWaitRefusal = "not_waiting" | "version_moved";

export type ReparkWaitOutcome =
  | { ok: true }
  | { ok: false; reason: ReparkWaitRefusal };

/** The `workflow_wait_states` slice of `ExecutionRepo`. */
export type WaitsRepoMethods = {
  /**
   * Park a run on a wait, answering the new row's id.
   *
   * The status flip runs first, behind the claim guard for this Wait's side and
   * the pinned version: a policy cancel can land between the run's last step and
   * this park, and a cancelled execution must not gain a live wait row that
   * resume matching would later hit, while a Migration landing in the same
   * window would leave the row holding a park resolved from a graph the run has
   * left. Undefined is either race lost.
   */
  readonly startWait: (input: {
    executionId: string;
    workflowId: string;
    runId: string;
    nodeId: string;
    nodeName: string;
    /** The version the caller resolved this park from. */
    workflowVersionId: string;
    /** Which side of the Lifecycle Node this Wait sits on. */
    side: ExecutionSide;
    waitType: "delay" | "event";
    resumeToken?: string | undefined;
    waitUntil?: Date | undefined;
    /** The Event names a delivery finds this row by. Empty for a wait on a clock. */
    subscribedEvents?: string[] | undefined;
    metadata?: JsonObjectDraft | undefined;
  }) => Effect.Effect<{ waitStateId: string } | undefined, DatabaseError>;
  /**
   * Write a re-parked wait's whole park onto the row it is already parked on,
   * answering whether a row still `waiting` was written and, when none was, why.
   *
   * A Migration moves an open Execution to another Workflow Version while it is
   * parked, and the Wait then parks again against the new version's config. The
   * row keeps its id and its `waiting` status, so the delivery fan-out keeps
   * addressing the same park. Everything else is the new version's answer,
   * including the wait type, so a Wait that changed mode re-parks as the mode it
   * now is.
   */
  readonly reparkWait: (input: {
    waitStateId: string;
    /** The version the caller resolved this park from. */
    workflowVersionId: string;
    /** Which side of the Lifecycle Node this Wait sits on. */
    side: ExecutionSide;
    waitType: "delay" | "event";
    waitUntil: Date | null;
    subscribedEvents: string[];
    resumeToken: string | null;
    metadata: JsonObject;
  }) => Effect.Effect<ReparkWaitOutcome, DatabaseError>;
  /** One wait row by id, whatever status it is in. */
  readonly findWaitStateById: (
    waitStateId: string
  ) => Effect.Effect<WorkflowWaitState | null, DatabaseError>;
  /**
   * Close out one wait row, answering whether it was still active.
   *
   * Every settled status is accepted from `waiting` and from `resuming`, so the
   * run that consumed a wake can close the row whether or not the producer that
   * sent the signal settled its own claim. A row closed this way no longer
   * carries a claim, so no later wake can reclaim it at any lease age.
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
   *
   * Only an event wait is claimable. A delay wait answers no resume signal, so
   * a row a Migration turned into a delay park keeps counting down rather than
   * consuming a manual resume that would reach nothing.
   */
  readonly claimWaitingStateByToken: (input: {
    resumeToken: string;
    arrival: WaitArrival;
  }) => Effect.Effect<WaitResumeClaim | null, DatabaseError>;
  /**
   * Claim one candidate previously found by event delivery. The execution may
   * already be running because a sibling wait resumed first.
   *
   * The claim repeats the two facts the candidate was selected on, because a
   * Migration can re-park the row between the selection and this write: the row
   * must still be an event wait, and must still be subscribed to `eventName`.
   */
  readonly claimWaitingStateById: (input: {
    waitStateId: string;
    /** The Event being delivered, which the row must still subscribe to. */
    eventName: string;
    arrival: WaitArrival;
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
   * Every wait row of one run in `waiting` or `resuming`, for the Exit wake.
   *
   * A `resuming` row is a resume producer's claim whose signal may not have
   * reached Inngest yet, so the Wait behind it can still be parked. A release
   * returns that row to `waiting` if the send fails, and an Exit claim then
   * refuses every later resume claim, so the Exit wake has to signal it too.
   */
  readonly listActiveWaitStates: (
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
          // The version predicate is this park's fence. The statement writes the
          // execution row itself, so the pin is compared on that row rather than
          // through the correlated subquery `reparkWait` needs.
          const parked = await tx
            .update(workflowExecutions)
            .set({ status: "waiting", waitingAt: new Date() })
            .where(
              and(
                inFlightExecution(input.executionId, input.side),
                eq(
                  workflowExecutions.workflowVersionId,
                  input.workflowVersionId
                )
              )
            )
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
      database.query((db) =>
        db.transaction(async (tx): Promise<ReparkWaitOutcome> => {
          const reparked = await tx
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
                eq(workflowWaitStates.status, "waiting"),
                pinsVersionAndAdmits(db, input.workflowVersionId, input.side)
              )
            )
            .returning({ id: workflowWaitStates.id });

          if (reparked.length > 0) {
            return { ok: true };
          }

          // Which of the two guards refused, read in the same transaction as the
          // write it explains. A row nobody holds reads as `not_waiting`, which
          // sends the caller to the wake the row would record.
          const [row] = await tx
            .select({
              status: workflowWaitStates.status,
              pinnedVersionId: workflowExecutions.workflowVersionId,
            })
            .from(workflowWaitStates)
            .leftJoin(
              workflowExecutions,
              eq(workflowExecutions.id, workflowWaitStates.executionId)
            )
            .where(eq(workflowWaitStates.id, input.waitStateId))
            .limit(1);

          return row?.status === "waiting" &&
            row.pinnedVersionId !== input.workflowVersionId
            ? { ok: false, reason: "version_moved" }
            : { ok: false, reason: "not_waiting" };
        })
      ),

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
              inArray(workflowWaitStates.status, ["waiting", "resuming"])
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
              notExitClaimed,
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
          and(
            eq(workflowWaitStates.resumeToken, input.resumeToken),
            eq(workflowWaitStates.waitType, "event")
          ),
          input.arrival
        )
      ),

    claimWaitingStateById: (input) =>
      database.query((db) =>
        claimWaitState(
          db,
          and(
            eq(workflowWaitStates.id, input.waitStateId),
            eq(workflowWaitStates.waitType, "event"),
            arrayContains(workflowWaitStates.subscribedEvents, [
              input.eventName,
            ])
          ),
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

    listActiveWaitStates: (executionId) =>
      database.query((db) =>
        db.query.workflowWaitStates.findMany({
          where: {
            executionId,
            status: { in: ["waiting", "resuming"] },
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
 * Whether the execution a wait row belongs to still pins this Workflow Version
 * and still admits work on this side.
 *
 * Correlated against `workflow_wait_states.execution_id`, so it is evaluated by
 * the statement it guards rather than as a separate read the caller could be
 * overtaken after.
 */
function pinsVersionAndAdmits(
  db: WfGraphDatabase,
  workflowVersionId: string,
  side: ExecutionSide
): SQL {
  return exists(
    db
      .select({ id: workflowExecutions.id })
      .from(workflowExecutions)
      .where(
        and(
          eq(workflowExecutions.id, workflowWaitStates.executionId),
          eq(workflowExecutions.workflowVersionId, workflowVersionId),
          claimAdmits(side)
        )
      )
  );
}

/**
 * Claims one row and records the wake in the same statement.
 *
 * The wake is merged into the metadata the park wrote rather than replacing it,
 * so the compiled match the row carries survives a claim.
 *
 * `identity` is everything about the row the caller requires, which is more than
 * its id: a Migration can re-park the row between a candidate read and this
 * write, so the claim re-states the properties the candidate was chosen for.
 */
async function claimWaitState(
  db: WfGraphDatabase,
  identity: SQL | undefined,
  arrival: WaitArrival
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
                ]),
                notExitClaimed
              )
            )
        )
      )
    )
    .returning();

  return waitState ? { waitState, claimedAt } : null;
}
