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
  isNull,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Effect } from "effect";
import { omit } from "es-toolkit/object";
import {
  workflowExecutions,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type {
  WfGraphDatabase,
  WfGraphTransaction,
} from "#src/backend/lib/db/index";
import {
  type Database,
  type DatabaseError,
  serializableTransaction,
} from "#src/backend/lib/effect/database";
import {
  IN_FLIGHT_EXECUTION_STATUSES,
  type ExecutionSide,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  readJsonObject,
  type JsonObject,
  type JsonObjectDraft,
  toJsonObject,
} from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  isWaitSignalType,
  WAIT_ARRIVAL_METADATA_KEY,
  type WaitArrival,
} from "@wfgraph/shared/lifecycle/wait-signal";
import {
  claimAdmits,
  inFlightExecution,
  notExitClaimed,
} from "#src/backend/services/executions/repo/runs";
import type {
  OwnerFence,
  ParkState,
  SettledWaitStatus,
  StoreWrite,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo/contracts";

type Executor = WfGraphDatabase | WfGraphTransaction;

const WAIT_RESUME_CLAIM_LEASE_MS = 5 * 60 * 1000;

export type WaitResumeClaim = {
  waitState: WorkflowWaitState;
  claimedAt: Date;
};

/** The claim's wake as it is stored, under one key of the row's metadata. */
function arrivalMetadata(arrival: WaitArrival): JsonObject {
  return { [WAIT_ARRIVAL_METADATA_KEY]: omitUndefined(arrival) };
}

function readWaitArrival(metadata: JsonObject | null): WaitArrival | null {
  const arrival = readJsonObject(metadata?.[WAIT_ARRIVAL_METADATA_KEY]);
  if (!arrival || !isWaitSignalType(arrival.signalType)) {
    return null;
  }
  return {
    signalType: arrival.signalType,
    eventName: typeof arrival.eventName === "string" ? arrival.eventName : null,
    payload: readJsonObject(arrival.payload) ?? {},
    deliveryId:
      typeof arrival.deliveryId === "string" ? arrival.deliveryId : undefined,
  };
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
   * Park a run, reusing its execution/run/node row on retry.
   *
   * The status flip runs first, behind the claim guard for this Wait's side and
   * the pinned version: a policy cancel can land between the run's last step and
   * this park, and a cancelled execution must not gain a live wait row that
   * resume matching would later hit, while a Migration landing in the same
   * window would leave the row holding a park resolved from a graph the run has
   * left. Undefined is either race lost. Existing non-waiting rows retain
   * their wake and are never reopened.
   */
  readonly startWait: StoreWrite<
    {
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
    },
    { waitStateId: string } | undefined
  >;
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
   *
   * Under the database executor a Migration resolves the park with a `migrate`
   * wake, which moves the row to `resuming`. A re-park also writes over a row
   * resolved with `migrate` or `timeout`, returning it to `waiting` with its
   * wake and park step cleared.
   */
  readonly reparkWait: StoreWrite<
    {
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
    },
    ReparkWaitOutcome
  >;
  /** One wait row by id, whatever status it is in. */
  readonly findWaitStateById: (
    waitStateId: string
  ) => Effect.Effect<WorkflowWaitState | null, DatabaseError>;
  /**
   * One park as the database executor reads it: the wake a producer or a claim
   * resolved it with, and the step that parked on it. Null when no row holds
   * that id.
   */
  readonly findPark: (
    waitStateId: string
  ) => Effect.Effect<ParkState | null, DatabaseError>;
  /**
   * Close out one wait row, answering whether it was still active.
   *
   * Every settled status is accepted from `waiting` and from `resuming`, so the
   * run that consumed a wake can close the row whether or not the producer that
   * sent the signal settled its own claim. A row closed this way no longer
   * carries a claim, so no later wake can reclaim it at any lease age.
   */
  readonly markWaitStatus: StoreWrite<
    {
      waitStateId: string;
      status: SettledWaitStatus;
    },
    boolean
  >;
  /**
   * Resolve the timeout against the row's persisted arrival in one fenced
   * transition. A valid arrival wins whether its claim is still `resuming`,
   * already `resumed`, or was released back to `waiting` after a refused send.
   */
  readonly settleWaitTimeout: StoreWrite<string, WaitArrival | null>;
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
  readonly cancelWaitsForExecution: StoreWrite<string, void>;
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
   * The claim repeats the candidate's event name and park token because a
   * Migration can re-park the row between selection and this write. The row
   * must still be an event wait, hold the selected token and subscribe to
   * `eventName`.
   */
  readonly claimWaitingStateById: (input: {
    waitStateId: string;
    /** The token on the candidate row, fencing a candidate from an earlier park. */
    resumeToken: string | null;
    /** The Event being delivered, which the row must still subscribe to. */
    eventName: string;
    /** Permit an empty arrival slot or replay of this arrival's delivery id. */
    allowSameDeliveryRetry?: boolean | undefined;
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
  /** Every wait one run is currently parked on, for the Runs view. */
  readonly listWaitingStates: (
    executionId: string
  ) => Effect.Effect<WorkflowWaitState[], DatabaseError>;
  /**
   * The node ids of the waits `listWaitingStates` answers, each once and in no
   * particular order, for the run status read the editor polls.
   */
  readonly listOpenWaitNodeIds: (
    executionId: string
  ) => Effect.Effect<string[], DatabaseError>;
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

type StartWaitInput = Parameters<WaitsRepoMethods["startWait"]>[0];
type ReparkWaitInput = Parameters<WaitsRepoMethods["reparkWait"]>[0];
type MarkWaitStatusInput = Parameters<WaitsRepoMethods["markWaitStatus"]>[0];

/**
 * Every column of a wait row but the database executor's two, which is the
 * shape `WorkflowWaitState` names. `findPark` reads the other two.
 */
const WAIT_STATE_COLUMNS = omit(getColumns(workflowWaitStates), [
  "parkStepId",
  "wake",
]);

/** The same choice for a relational query, which names what it leaves out. */
const WITHOUT_PARK_COLUMNS = { parkStepId: false, wake: false } as const;

/** The park behind `startWait`, on whichever handle the caller holds. */
export function startWaitWrite(input: StartWaitInput) {
  return (db: Executor) =>
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
            eq(workflowExecutions.workflowVersionId, input.workflowVersionId)
          )
        )
        .returning({ id: workflowExecutions.id });

      if (parked.length === 0) {
        return undefined;
      }

      // The execution update serializes competing prepares for this run.
      const [existing] = await tx
        .select()
        .from(workflowWaitStates)
        .where(
          and(
            eq(workflowWaitStates.executionId, input.executionId),
            eq(workflowWaitStates.runId, input.runId),
            eq(workflowWaitStates.nodeId, input.nodeId)
          )
        )
        .limit(1)
        .for("update");
      if (existing) {
        if (existing.status === "waiting") {
          await tx
            .update(workflowWaitStates)
            .set({
              waitType: input.waitType,
              resumeToken: input.resumeToken ?? null,
              waitUntil: input.waitUntil ?? null,
              subscribedEvents: input.subscribedEvents ?? [],
              metadata: {
                ...existing.metadata,
                ...toJsonObject(input.metadata),
              },
            })
            .where(eq(workflowWaitStates.id, existing.id));
        }
        return { waitStateId: existing.id };
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
    });
}

/**
 * A wait row a re-park may write over: one still `waiting`, or one the
 * database executor resolved with a wake the re-park supersedes. A `migrate`
 * wake is the instruction to prepare again, and a `timeout` wake read under a
 * version the run has since left is discarded the same way. Any other wake is
 * an Event or a claim the Wait still has to act on.
 */
function reparkableWait(): SQL {
  return sql`(${workflowWaitStates.status} = 'waiting' or (${workflowWaitStates.status} = 'resuming' and ${workflowWaitStates.wake}->>'kind' in ('migrate', 'timeout')))`;
}

/**
 * The re-park behind `reparkWait`. Given a fence, it reaches only a wait row of
 * the fenced Execution. The row goes back to `waiting` with no wake and no
 * park step, so the next `waitForEvent` parks on it afresh.
 */
export function reparkWaitWrite(input: ReparkWaitInput, fence?: OwnerFence) {
  return (db: Executor) =>
    db.transaction(async (tx): Promise<ReparkWaitOutcome> => {
      // Migration and startWait lock the execution before its Wait rows. A
      // version subquery alone can retain a pre-migration snapshot while this
      // update waits for a Wait-row lock.
      await tx
        .select({ id: workflowExecutions.id })
        .from(workflowExecutions)
        .where(
          exists(
            tx
              .select({ id: workflowWaitStates.id })
              .from(workflowWaitStates)
              .where(
                and(
                  eq(workflowWaitStates.id, input.waitStateId),
                  eq(workflowWaitStates.executionId, workflowExecutions.id)
                )
              )
          )
        )
        .for("update");
      const reparked = await tx
        .update(workflowWaitStates)
        .set({
          waitType: input.waitType,
          waitUntil: input.waitUntil,
          subscribedEvents: input.subscribedEvents,
          resumeToken: input.resumeToken,
          metadata: sql`coalesce(${workflowWaitStates.metadata}, '{}'::jsonb) || ${input.metadata}::jsonb`,
          status: "waiting",
          wake: null,
          parkStepId: null,
        })
        .where(
          and(
            eq(workflowWaitStates.id, input.waitStateId),
            ofFencedExecution(fence),
            reparkableWait(),
            pinsVersionAndAdmits(tx, input.workflowVersionId, input.side)
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
          reparkable: sql<boolean>`${reparkableWait()}`,
          pinnedVersionId: workflowExecutions.workflowVersionId,
        })
        .from(workflowWaitStates)
        .leftJoin(
          workflowExecutions,
          eq(workflowExecutions.id, workflowWaitStates.executionId)
        )
        .where(eq(workflowWaitStates.id, input.waitStateId))
        .limit(1);

      return row !== undefined &&
        row.reparkable &&
        row.pinnedVersionId !== input.workflowVersionId
        ? { ok: false, reason: "version_moved" }
        : { ok: false, reason: "not_waiting" };
    });
}

/**
 * The settle behind `markWaitStatus`. Given a fence, it reaches only a wait
 * row of the fenced Execution.
 */
export function markWaitStatusWrite(
  input: MarkWaitStatusInput,
  fence?: OwnerFence
) {
  return async (db: Executor): Promise<boolean> => {
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
          ofFencedExecution(fence),
          inArray(workflowWaitStates.status, ["waiting", "resuming"])
        )
      )
      .returning({ id: workflowWaitStates.id });

    return settled.length > 0;
  };
}

/**
 * The transition behind `settleWaitTimeout`, run as a serializable
 * transaction. Given a fence, it reaches only a wait row of the fenced
 * Execution.
 */
export function settleWaitTimeoutWrite(
  waitStateId: string,
  fence?: OwnerFence
) {
  return async (tx: WfGraphTransaction): Promise<WaitArrival | null> => {
    const [row] = await tx
      .select({
        status: workflowWaitStates.status,
        metadata: workflowWaitStates.metadata,
      })
      .from(workflowWaitStates)
      .where(
        and(eq(workflowWaitStates.id, waitStateId), ofFencedExecution(fence))
      )
      .limit(1);

    if (!row) return null;

    const arrival = readWaitArrival(row.metadata);
    if (row.status === "resumed") return arrival;
    if (row.status !== "waiting" && row.status !== "resuming") return null;

    const settled = await tx
      .update(workflowWaitStates)
      .set({
        status: arrival ? "resumed" : "timed_out",
        resumedAt: new Date(),
      })
      .where(
        and(
          eq(workflowWaitStates.id, waitStateId),
          eq(workflowWaitStates.status, row.status)
        )
      )
      .returning({ id: workflowWaitStates.id });

    return settled.length > 0 ? arrival : null;
  };
}

/** The update behind `cancelWaitsForExecution`. */
export function cancelWaitsForExecutionWrite(executionId: string) {
  return async (db: Executor): Promise<void> => {
    await db
      .update(workflowWaitStates)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(
        and(
          eq(workflowWaitStates.executionId, executionId),
          inArray(workflowWaitStates.status, ["waiting", "resuming"])
        )
      );
  };
}

/** Builds the `workflow_wait_states` slice of `ExecutionRepo` over one database. */
export function makeWaitsMethods(
  database: Database["Service"]
): WaitsRepoMethods {
  return {
    startWait: (input) => database.query(startWaitWrite(input)),

    reparkWait: (input) => database.query(reparkWaitWrite(input)),

    findWaitStateById: (waitStateId) =>
      database.query(async (db) => {
        const [row] = await db
          .select(WAIT_STATE_COLUMNS)
          .from(workflowWaitStates)
          .where(eq(workflowWaitStates.id, waitStateId))
          .limit(1);
        return row ?? null;
      }),

    findPark: (waitStateId) =>
      database.query(async (db) => {
        const [row] = await db
          .select({
            waitStateId: workflowWaitStates.id,
            executionId: workflowWaitStates.executionId,
            status: workflowWaitStates.status,
            parkStepId: workflowWaitStates.parkStepId,
            wake: workflowWaitStates.wake,
          })
          .from(workflowWaitStates)
          .where(eq(workflowWaitStates.id, waitStateId))
          .limit(1);
        return row ?? null;
      }),

    markWaitStatus: (input) => database.query(markWaitStatusWrite(input)),

    settleWaitTimeout: (waitStateId) =>
      serializableTransaction(database, settleWaitTimeoutWrite(waitStateId)),

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
      database.query(cancelWaitsForExecutionWrite(executionId)),

    listWaitsForEvent: (input) =>
      database.query((db) =>
        db
          .select(WAIT_STATE_COLUMNS)
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
            input.resumeToken === null
              ? isNull(workflowWaitStates.resumeToken)
              : eq(workflowWaitStates.resumeToken, input.resumeToken),
            arrayContains(workflowWaitStates.subscribedEvents, [
              input.eventName,
            ]),
            input.allowSameDeliveryRetry
              ? or(
                  isNull(
                    sql`${workflowWaitStates.metadata} -> ${WAIT_ARRIVAL_METADATA_KEY}::text`
                  ),
                  input.arrival.deliveryId === undefined
                    ? undefined
                    : eq(
                        sql`${workflowWaitStates.metadata} -> ${WAIT_ARRIVAL_METADATA_KEY}::text ->> 'deliveryId'`,
                        input.arrival.deliveryId
                      )
                )
              : undefined
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
          columns: WITHOUT_PARK_COLUMNS,
          where: {
            executionId,
            status: "waiting",
          },
        })
      ),

    listOpenWaitNodeIds: (executionId) =>
      database.query(async (db) => {
        const rows = await db
          .selectDistinct({ nodeId: workflowWaitStates.nodeId })
          .from(workflowWaitStates)
          .where(
            and(
              eq(workflowWaitStates.executionId, executionId),
              eq(workflowWaitStates.status, "waiting")
            )
          );
        return rows.map((row) => row.nodeId);
      }),

    listActiveWaitStates: (executionId) =>
      database.query((db) =>
        db.query.workflowWaitStates.findMany({
          columns: WITHOUT_PARK_COLUMNS,
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
          columns: WITHOUT_PARK_COLUMNS,
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
 * Narrows a fenced write to the wait rows of the Execution its pass runs, so a
 * fenced write addressed by wait row id cannot reach another run's row.
 */
function ofFencedExecution(fence: OwnerFence | undefined): SQL | undefined {
  return fence === undefined
    ? undefined
    : eq(workflowWaitStates.executionId, fence.executionId);
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
  db: WfGraphDatabase | WfGraphTransaction,
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
      metadata: sql`coalesce(${workflowWaitStates.metadata}, '{}'::jsonb) || ${arrivalMetadata(arrival)}::jsonb`,
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
    .returning(WAIT_STATE_COLUMNS);

  return waitState ? { waitState, claimedAt } : null;
}
