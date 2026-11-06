/**
 * The PostgreSQL producers that claim a run's parks: an Event or a manual
 * resume claiming one park, a Cancel Event claiming every run about an Entity,
 * and a Migration's repin. Each runs as one transaction through
 * `wakeExecutions`, which locks the runs' schedule rows first and makes due
 * the rows of the runs the claim woke. `release-policy.ts` decides which parks
 * a claim may take.
 */

import {
  and,
  arrayContains,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  type SQL,
} from "drizzle-orm";
import type { Effect } from "effect";
import {
  workflowCancelDecisions,
  workflowExecutions,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import { recordAuditEventsWrite } from "#src/backend/services/executions/repo/audit";
import type { WfGraphDatabase } from "#src/backend/lib/db/index";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import type { JsonObject } from "@wfgraph/shared/types/json";
import type { WaitArrival } from "@wfgraph/shared/lifecycle/wait-signal";
import type {
  CanceledOutletClaim,
  RepinOutcome,
  WaitResumeClaim,
} from "#src/backend/services/executions/repo/contracts";
import {
  type CancelClaimWrite,
  type CancelScope,
  cancelClaimable,
  cancelRequestedEntries,
  canceledOutletClaims,
  claimablePark,
  claimedEarlierBy,
  claimedByDelivery,
  matchesClassification,
  resumeWakeOf,
} from "#src/backend/services/executions/repo/release-policy";
import { notExitClaimed } from "#src/backend/services/executions/repo/runs";
import {
  resolveOpenParks,
  wakeExecutions,
} from "#src/backend/services/executions/repo/schedule";
import { WAIT_STATE_COLUMNS } from "#src/backend/services/executions/repo/waits";

/** The producers' slice of `ExecutionRepo`: the writes that claim a run's parks. */
export type ClaimsRepoMethods = {
  /**
   * Claim the event park one resume token addresses, for a manual resume, and
   * resolve it with the arrival as a `resume` wake. See `claimWaitState` for
   * what a claim writes and which rows it takes.
   *
   * Only an event wait is claimable. A delay wait answers no resume, so a row
   * a Migration turned into a delay park keeps counting down rather than
   * consuming a manual resume.
   */
  readonly claimWaitingStateByToken: (input: {
    resumeToken: string;
    arrival: WaitArrival;
    /** When the run becomes due, if the claim re-queues it. */
    now: Date;
  }) => Effect.Effect<WaitResumeClaim | null, DatabaseError>;
  /**
   * Claim one candidate an Event delivery selected, and resolve it with the
   * arrival as a `resume` wake. The execution may already be running because a
   * sibling wait resumed first.
   *
   * The claim repeats the candidate's event name and park token because a
   * Migration can re-park the row between selection and this write. The row
   * must still be an event wait, hold the selected token and subscribe to
   * `eventName`.
   *
   * The arrival's `deliveryId` is the retry identity: a row whose `resume`
   * wake that same delivery already wrote answers as claimed, with `requeued:
   * false` and nothing written, so a retried delivery counts it.
   */
  readonly claimWaitingStateById: (input: {
    waitStateId: string;
    /** The token on the candidate row, fencing a candidate from an earlier park. */
    resumeToken: string | null;
    /** The Event being delivered, which the row must still subscribe to. */
    eventName: string;
    arrival: WaitArrival;
    /** When the run becomes due, if the claim re-queues it. */
    now: Date;
  }) => Effect.Effect<WaitResumeClaim | null, DatabaseError>;
  /**
   * The Migration producer: move a parked run's pinned version pointer,
   * answering whether a row moved and whether the run was made due. In the
   * same transaction every park is resolved with a `migrate` wake and the run
   * is made due (`wakeExecutions`); a leased run's release reads the wakes
   * instead. The next pass loads the version the run now pins and prepares
   * each Wait again.
   *
   * The version, status, and exact parked Wait set must still match the
   * classification. A wake, repark, or newly parked branch invalidates it, so
   * a run that is running or holds a woken Wait is refused: the work below a
   * Wait then stays on the version the run pinned when the Wait resumed. The
   * run's schedule row is locked before its execution row, the order the
   * release and every producer take them in.
   */
  readonly repinVersion: (input: {
    executionId: string;
    fromVersionId: string;
    toVersionId: string;
    expectedWaitStates: readonly { id: string; resumeToken: string | null }[];
    now: Date;
  }) => Effect.Effect<RepinOutcome, DatabaseError>;
  /**
   * The Cancel producer: flag every in-flight run of this workflow about this
   * entity for the Canceled outlet, answering what the claim did to each run
   * it flagged.
   *
   * One transaction through `wakeExecutions`, which locks the candidates'
   * schedule rows first, and the flag is written only on a candidate still in
   * flight with no claim, so a run that reached a verdict in between is not
   * flagged. A run already flagged is skipped, so the first Cancel Event owns
   * the payload the Canceled branch runs against. Each flagged run's parks
   * still `waiting` are resolved with a `cancel` wake and the run is made due,
   * so the next pass reads the claim at its `lifecycle-check` step and routes
   * the Canceled outlet. The rows keep their status: the run ends itself once
   * its outlet has run. Each flagged run gets its `run_cancel_requested`
   * timeline entry in the same transaction.
   *
   * The claim records its decision as a `workflow_cancel_decisions` row for
   * this workflow and `deliveryId`, whether or not it flagged a run, and
   * records `deliveryId` on each run it flags. A retried delivery that finds
   * the decision flags nothing, so a run that opened after the first attempt
   * stays unclaimed, and answers the runs the first attempt flagged as
   * `claimed_earlier`, whatever they have done since.
   */
  readonly requestCancelForEntity: (
    input: CancelScope & {
      eventName: string;
      payload: JsonObject;
      /** The arrival's inbox id, which a retried delivery is answered by. */
      deliveryId: string;
      now: Date;
    }
  ) => Effect.Effect<CanceledOutletClaim[], DatabaseError>;
};

type RepinInput = Parameters<ClaimsRepoMethods["repinVersion"]>[0];
type CancelInput = Parameters<ClaimsRepoMethods["requestCancelForEntity"]>[0];

/**
 * Claims one park for an Event or a manual resume, through `wakeExecutions`.
 *
 * The claim writes the `resume` wake and `resuming`, which is the one record
 * of the resume, and the run is made due.
 *
 * `identity` is everything about the row the caller requires, which is more than
 * its id: a Migration can re-park the row between a candidate read and this
 * write, so the claim re-states the properties the candidate was chosen for.
 * The park must be one `claimablePark` takes, and the run must still be in
 * flight and hold no Exit claim.
 *
 * An arrival with a `deliveryId` may be a retry of its own delivery. A row
 * whose `resume` wake that delivery already wrote answers as claimed with
 * `requeued: false`, and the claim writes nothing.
 */
async function claimWaitState(
  db: WfGraphDatabase,
  input: {
    identity: SQL | undefined;
    arrival: WaitArrival;
    now: Date;
  }
): Promise<WaitResumeClaim | null> {
  const { identity, arrival, now } = input;
  const { result, due } = await wakeExecutions(
    db,
    {
      now,
      candidates: async (tx) => {
        const [candidate] = await tx
          .select({ executionId: workflowWaitStates.executionId })
          .from(workflowWaitStates)
          .where(identity)
          .limit(1);
        return candidate === undefined ? [] : [candidate.executionId];
      },
    },
    async (tx, candidateIds) => {
      if (candidateIds.length === 0) return { result: null, woken: [] };
      const [waitState] = await tx
        .update(workflowWaitStates)
        .set({
          status: "resuming",
          resumedAt: now,
          wake: resumeWakeOf(arrival),
        })
        .where(
          and(
            identity,
            inArray(workflowWaitStates.executionId, [...candidateIds]),
            claimablePark(workflowWaitStates),
            exists(
              tx
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
      if (waitState) {
        return { result: waitState, woken: [waitState.executionId] };
      }
      if (arrival.deliveryId === undefined) return { result: null, woken: [] };
      const [ownClaim] = await tx
        .select(WAIT_STATE_COLUMNS)
        .from(workflowWaitStates)
        .where(
          and(
            identity,
            claimedByDelivery(workflowWaitStates, arrival.deliveryId)
          )
        )
        .limit(1);
      return { result: ownClaim ?? null, woken: [] };
    }
  );
  return result === null
    ? null
    : { waitState: result, requeued: due.length > 0 };
}

/** The Migration producer behind `repinVersion`. */
async function repinVersionWrite(
  db: WfGraphDatabase,
  input: RepinInput
): Promise<RepinOutcome> {
  // The schedule row first, as every other writer of a run takes it. A
  // release then either commits before this repin reads the wait rows, or
  // reads the migrate wakes this repin writes.
  const { result: moved, due } = await wakeExecutions(
    db,
    { now: input.now, candidates: async () => [input.executionId] },
    async (tx) => {
      const refused = { result: false, woken: [] };
      // startWait takes this lock before inserting a row. Lock Wait rows
      // next so delivery cannot change the classified set during the move.
      const [execution] = await tx
        .select({ id: workflowExecutions.id })
        .from(workflowExecutions)
        .where(
          and(
            eq(workflowExecutions.id, input.executionId),
            eq(workflowExecutions.status, "waiting"),
            eq(workflowExecutions.workflowVersionId, input.fromVersionId),
            isNull(workflowExecutions.terminationKind)
          )
        )
        .for("update");
      if (!execution) return refused;

      const parked = await tx
        .select({
          id: workflowWaitStates.id,
          resumeToken: workflowWaitStates.resumeToken,
          status: workflowWaitStates.status,
        })
        .from(workflowWaitStates)
        .where(
          and(
            eq(workflowWaitStates.executionId, input.executionId),
            inArray(workflowWaitStates.status, ["waiting", "resuming"])
          )
        )
        .orderBy(asc(workflowWaitStates.id))
        .for("update");
      if (!matchesClassification(parked, input.expectedWaitStates)) {
        return refused;
      }

      await tx
        .update(workflowExecutions)
        .set({ workflowVersionId: input.toVersionId })
        .where(eq(workflowExecutions.id, input.executionId));
      await resolveOpenParks(tx, [input.executionId], { kind: "migrate" });
      return { result: true, woken: [input.executionId] };
    }
  );
  return moved ? { moved: true, requeued: due.length > 0 } : { moved: false };
}

/**
 * The Cancel producer behind `requestCancelForEntity`. The decision row is
 * inserted before anything else the claim decides, so a second attempt of the
 * same delivery waits on the first attempt's transaction and then reads every
 * run it flagged.
 */
async function requestCancelForEntityWrite(
  db: WfGraphDatabase,
  input: CancelInput
): Promise<CanceledOutletClaim[]> {
  const claimable = cancelClaimable(workflowExecutions, input);
  const produced = await wakeExecutions(
    db,
    {
      now: input.now,
      candidates: async (tx) => {
        const candidates = await tx
          .select({ id: workflowExecutions.id })
          .from(workflowExecutions)
          .where(claimable);
        return candidates.map((row) => row.id);
      },
    },
    async (tx, candidateIds): Promise<CancelClaimWrite> => {
      const [decided] = await tx
        .insert(workflowCancelDecisions)
        .values({
          deliveryId: input.deliveryId,
          workflowId: input.workflowId,
          decidedAt: input.now,
        })
        .onConflictDoNothing()
        .returning({ deliveryId: workflowCancelDecisions.deliveryId });
      if (!decided) {
        const claimedEarlier = await tx
          .select({ id: workflowExecutions.id })
          .from(workflowExecutions)
          .where(claimedEarlierBy(workflowExecutions, input));
        return {
          result: {
            flagged: [],
            resolved: [],
            claimedEarlier: claimedEarlier.map((row) => row.id),
          },
          woken: [],
        };
      }
      if (candidateIds.length === 0) {
        return {
          result: { flagged: [], resolved: [], claimedEarlier: [] },
          woken: [],
        };
      }
      const flagged = await tx
        .update(workflowExecutions)
        .set({
          terminationKind: "cancel",
          terminationRequestedAt: input.now,
          cancelEventName: input.eventName,
          cancelPayload: input.payload,
          cancelDeliveryId: input.deliveryId,
        })
        .where(
          and(inArray(workflowExecutions.id, [...candidateIds]), claimable)
        )
        .returning({ id: workflowExecutions.id });
      const flaggedIds = flagged.map((row) => row.id);
      const resolved = await resolveOpenParks(tx, flaggedIds, {
        kind: "cancel",
      });
      await recordAuditEventsWrite(
        cancelRequestedEntries({
          workflowId: input.workflowId,
          eventName: input.eventName,
          flagged: flaggedIds,
          resolved,
        })
      )(tx);
      return {
        result: { flagged: flaggedIds, resolved, claimedEarlier: [] },
        woken: flaggedIds,
      };
    }
  );
  return canceledOutletClaims(produced);
}

/** Builds the producers' slice of `ExecutionRepo` over one database. */
export function makeClaimsMethods(
  database: Database["Service"]
): ClaimsRepoMethods {
  return {
    claimWaitingStateByToken: (input) =>
      database.query((db) =>
        claimWaitState(db, {
          identity: and(
            eq(workflowWaitStates.resumeToken, input.resumeToken),
            eq(workflowWaitStates.waitType, "event")
          ),
          arrival: input.arrival,
          now: input.now,
        })
      ),

    claimWaitingStateById: (input) =>
      database.query((db) =>
        claimWaitState(db, {
          identity: and(
            eq(workflowWaitStates.id, input.waitStateId),
            eq(workflowWaitStates.waitType, "event"),
            input.resumeToken === null
              ? isNull(workflowWaitStates.resumeToken)
              : eq(workflowWaitStates.resumeToken, input.resumeToken),
            arrayContains(workflowWaitStates.subscribedEvents, [
              input.eventName,
            ])
          ),
          arrival: input.arrival,
          now: input.now,
        })
      ),

    repinVersion: (input) =>
      database.query((db) => repinVersionWrite(db, input)),

    requestCancelForEntity: (input) =>
      database.query((db) => requestCancelForEntityWrite(db, input)),
  };
}
