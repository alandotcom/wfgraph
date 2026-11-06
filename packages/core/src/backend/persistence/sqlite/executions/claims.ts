/**
 * The producers' slice of the SQLite `ExecutionRepo`, the twin of
 * `services/executions/repo/claims.ts`: an Event or a manual resume claiming
 * one park, a Cancel Event claiming every run about an Entity, and a
 * Migration's repin. Each runs inside one `BEGIN IMMEDIATE` write transaction,
 * which holds the one writer from its first statement, so the claim, its wakes
 * and the re-queue land together and a release runs wholly before or after
 * them (`wakeExecutions`).
 */

import { Effect } from "effect";
import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import type { WaitArrival } from "@wfgraph/shared/lifecycle/wait-signal";
import type {
  RepinOutcome,
  WaitResumeClaim,
} from "#src/backend/services/executions/repo";
import type { ClaimsRepoMethods } from "#src/backend/services/executions/repo/claims";
import {
  type CancelClaimWrite,
  cancelClaimable,
  cancelRequestedEntries,
  canceledOutletClaims,
  claimablePark,
  claimedByDelivery,
  claimedEarlierBy,
  matchesClassification,
  resumeWakeOf,
} from "#src/backend/services/executions/repo/release-policy";
import type {
  SqliteDatabase,
  SqliteExecutor,
} from "#src/backend/persistence/sqlite/database";
import { encodeJson } from "#src/backend/persistence/sqlite/database";
import {
  workflowCancelDecisions,
  workflowExecutions,
  workflowWaitStates,
} from "#src/backend/persistence/sqlite/schema";
import { recordAuditEventsWrite } from "#src/backend/persistence/sqlite/executions/audit";
import { sqliteWaitState } from "#src/backend/persistence/sqlite/executions/rows";
import { notExitClaimed } from "#src/backend/persistence/sqlite/executions/runs";
import {
  resolveOpenParks,
  wakeExecutions,
} from "#src/backend/persistence/sqlite/executions/schedule";
import { subscribedTo } from "#src/backend/persistence/sqlite/executions/waits";

/**
 * Claims one park for an Event or a manual resume through `wakeExecutions`,
 * as the PostgreSQL backend's `claimWaitState` does: the `resume` wake and
 * `resuming`, then the run made due. A row whose `resume` wake the arrival's
 * own delivery already wrote answers as claimed, unwritten and not re-queued.
 */
function claimWait(
  database: SqliteExecutor,
  input: {
    identity: SQL | undefined;
    arrival: WaitArrival;
    now: Date;
  }
): Effect.Effect<WaitResumeClaim | null, unknown> {
  const { identity, arrival, now } = input;
  const claim = Effect.gen(function* () {
    const unclaimed = { result: null, woken: [] };
    const candidate = yield* database
      .select({ id: workflowWaitStates.id })
      .from(workflowWaitStates)
      .innerJoin(
        workflowExecutions,
        eq(workflowExecutions.id, workflowWaitStates.executionId)
      )
      .where(
        and(
          identity,
          claimablePark(workflowWaitStates),
          inArray(workflowExecutions.status, IN_FLIGHT_EXECUTION_STATUSES),
          notExitClaimed
        )
      )
      .get();
    if (!candidate) {
      if (arrival.deliveryId === undefined) return unclaimed;
      const ownClaim = yield* database
        .select()
        .from(workflowWaitStates)
        .where(
          and(
            identity,
            claimedByDelivery(workflowWaitStates, arrival.deliveryId)
          )
        )
        .get();
      return {
        result: ownClaim ? sqliteWaitState(ownClaim) : null,
        woken: [],
      };
    }
    const [claimed] = yield* database
      .update(workflowWaitStates)
      .set({
        status: "resuming",
        resumedAt: now.getTime(),
        wake: encodeJson(resumeWakeOf(arrival)),
      })
      .where(
        and(
          eq(workflowWaitStates.id, candidate.id),
          identity,
          claimablePark(workflowWaitStates)
        )
      )
      .returning();
    if (!claimed) return unclaimed;
    const waitState = sqliteWaitState(claimed);
    return { result: waitState, woken: [waitState.executionId] };
  });
  return Effect.map(wakeExecutions(database, now, claim), ({ result, due }) =>
    result === null ? null : { waitState: result, requeued: due.length > 0 }
  );
}

type RepinInput = Parameters<ClaimsRepoMethods["repinVersion"]>[0];
type CancelInput = Parameters<ClaimsRepoMethods["requestCancelForEntity"]>[0];

/**
 * The Migration producer behind `repinVersion`. The write transaction takes
 * the run's schedule row, execution row and wait rows together.
 */
function repinVersionWrite(database: SqliteExecutor, input: RepinInput) {
  return Effect.gen(function* () {
    const refused: RepinOutcome = { moved: false };
    const parked = yield* database
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
      );
    if (!matchesClassification(parked, input.expectedWaitStates)) {
      return refused;
    }
    const moved = yield* database
      .update(workflowExecutions)
      .set({ workflowVersionId: input.toVersionId })
      .where(
        and(
          eq(workflowExecutions.id, input.executionId),
          eq(workflowExecutions.status, "waiting"),
          eq(workflowExecutions.workflowVersionId, input.fromVersionId),
          isNull(workflowExecutions.terminationKind)
        )
      )
      .returning({ id: workflowExecutions.id });
    if (moved.length === 0) return refused;
    const { due } = yield* wakeExecutions(
      database,
      input.now,
      Effect.as(
        resolveOpenParks(database, [input.executionId], { kind: "migrate" }),
        { result: undefined, woken: [input.executionId] }
      )
    );
    const repinned: RepinOutcome = { moved: true, requeued: due.length > 0 };
    return repinned;
  });
}

/**
 * The Cancel producer behind `requestCancelForEntity`. The write transaction
 * holds the one writer, so the decision row and every flag it guards land
 * together.
 */
function requestCancelForEntityWrite(
  database: SqliteExecutor,
  input: CancelInput
) {
  return wakeExecutions(
    database,
    input.now,
    Effect.gen(function* (): Effect.fn.Return<CancelClaimWrite, unknown> {
      const decided = yield* database
        .insert(workflowCancelDecisions)
        .values({
          deliveryId: input.deliveryId,
          workflowId: input.workflowId,
          decidedAt: input.now.getTime(),
        })
        .onConflictDoNothing()
        .returning({ deliveryId: workflowCancelDecisions.deliveryId });
      if (decided.length === 0) {
        const claimedEarlier = yield* database
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
      const flagged = yield* database
        .update(workflowExecutions)
        .set({
          terminationKind: "cancel",
          terminationRequestedAt: input.now.getTime(),
          cancelEventName: input.eventName,
          cancelPayload: encodeJson(input.payload),
          cancelDeliveryId: input.deliveryId,
        })
        .where(cancelClaimable(workflowExecutions, input))
        .returning({ id: workflowExecutions.id });
      const flaggedIds = flagged.map((row) => row.id);
      const resolved = yield* resolveOpenParks(database, flaggedIds, {
        kind: "cancel",
      });
      yield* recordAuditEventsWrite(
        cancelRequestedEntries({
          workflowId: input.workflowId,
          eventName: input.eventName,
          flagged: flaggedIds,
          resolved,
        })
      )(database);
      return {
        result: { flagged: flaggedIds, resolved, claimedEarlier: [] },
        woken: flaggedIds,
      };
    })
  ).pipe(Effect.map(canceledOutletClaims));
}

export function makeSqliteClaimsMethods(
  store: SqliteDatabase
): ClaimsRepoMethods {
  return {
    claimWaitingStateByToken: (input) =>
      store.write((database) =>
        claimWait(database, {
          identity: and(
            eq(workflowWaitStates.resumeToken, input.resumeToken),
            eq(workflowWaitStates.waitType, "event")
          ),
          arrival: input.arrival,
          now: input.now,
        })
      ),
    claimWaitingStateById: (input) =>
      store.write((database) =>
        claimWait(database, {
          identity: and(
            eq(workflowWaitStates.id, input.waitStateId),
            eq(workflowWaitStates.waitType, "event"),
            input.resumeToken === null
              ? isNull(workflowWaitStates.resumeToken)
              : eq(workflowWaitStates.resumeToken, input.resumeToken),
            subscribedTo(input.eventName)
          ),
          arrival: input.arrival,
          now: input.now,
        })
      ),
    repinVersion: (input) =>
      store.write((database) => repinVersionWrite(database, input)),
    requestCancelForEntity: (input) =>
      store.write((database) => requestCancelForEntityWrite(database, input)),
  };
}
