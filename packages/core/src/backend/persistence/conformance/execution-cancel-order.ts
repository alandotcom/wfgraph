/**
 * The arrival-order rule between a Cancel Event and a start: a Cancel claims
 * a run whose start Event was received no later than the Cancel Event was, and
 * no run whose start Event was received after it, whichever of the two the
 * executor delivers first. A run no Event started, or whose start's inbox row
 * is gone, has no arrival to compare and is claimed as before.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  type ExecutionEntitySelector,
  ExecutionRepo,
} from "#src/backend/services/executions/repo";
import {
  type PersistenceTestRegistry,
  notYetDue,
} from "#src/backend/persistence/conformance/support";
import {
  T0,
  at,
  seeded,
} from "#src/backend/persistence/conformance/schedule-support";

const CANCEL_REASON = { reason: "customer left" };

/** Records one arrival of `name` in the inbox at `now`, answering its id. */
function arrive(name: string, now: Date) {
  return Effect.flatMap(ExecutionRepo, (executions) =>
    executions
      .insertInboxEvent({
        name,
        data: name === "appointment/cancelled" ? CANCEL_REASON : {},
        connectionId: null,
        idempotencyKey: null,
        now,
      })
      .pipe(Effect.map((arrival) => arrival.inboxId))
  );
}

/** The Cancel Event delivered under `deliveryId`, for `entity`. */
function cancel(
  deliveryId: string,
  now: Date,
  entity: ExecutionEntitySelector = { entityValue: "appointment_1" }
) {
  return Effect.flatMap(ExecutionRepo, (executions) =>
    executions.requestCancelForEntity({
      workflowId: "wf_1",
      eventName: "appointment/cancelled",
      payload: CANCEL_REASON,
      deliveryId,
      now,
      ...entity,
    })
  );
}

/** The start delivered under `deliveryId`, for `entity`, answering its run. */
function start(
  deliveryId: string | undefined,
  now: Date,
  entity: ExecutionEntitySelector = { entityValue: "appointment_1" }
) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const started = yield* executions.startForEntity({
      execution: {
        workflowId: "wf_1",
        workflowVersionId: "ver_1",
        startSource: deliveryId === undefined ? "manual" : "event",
        runMode: "live",
        startEventName:
          deliveryId === undefined ? undefined : "appointment/booked",
        deliveryId,
        input: {},
        ...entity,
      },
      concurrency: "unlimited",
      startedEntry: notYetDue.startedEntry,
      now,
    });
    if (started.status !== "started") throw new Error("Start refused");
    return started.execution.id;
  });
}

/** Whether the run carries a Cancel claim, and what its timeline says of it. */
function cancelOf(executionId: string) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const termination = yield* executions.findTerminationState(executionId);
    const timeline = yield* executions.listEvents(executionId);
    return {
      claim: termination?.claim?.kind ?? null,
      pending: yield* executions.findPendingCancel(executionId),
      requested: timeline.filter(
        (entry) => entry.eventType === "run_cancel_requested"
      ).length,
    };
  });
}

const canceled = {
  claim: "cancel",
  pending: { eventName: "appointment/cancelled", payload: CANCEL_REASON },
  requested: 1,
};
const untouched = { claim: null, pending: null, requested: 0 };

export function describeExecutionCancelOrderConformance({
  openConnection,
}: PersistenceTestRegistry): void {
  describe("Cancel Events and starts by arrival order", () => {
    it("claims a run whose start was received before the Cancel Event, whichever the executor delivers first", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          // Delivered in arrival order.
          const inOrderStart = yield* arrive("appointment/booked", T0);
          const inOrderCancel = yield* arrive("appointment/cancelled", at(1));
          const inOrderRun = yield* start(inOrderStart, at(10));
          const inOrderClaims = yield* cancel(inOrderCancel, at(20));

          // The Cancel delivered first, while the start's delivery was held
          // back. The start, delivered later, finds the Cancel's decision.
          const lateStart = yield* arrive("appointment/booked", at(100));
          const earlyCancel = yield* arrive("appointment/cancelled", at(101));
          const earlyClaims = yield* cancel(earlyCancel, at(110));
          const lateRun = yield* start(lateStart, at(120));

          return {
            inOrderClaims: inOrderClaims.map((claim) => claim.executionId),
            inOrder: yield* cancelOf(inOrderRun),
            inOrderRun,
            earlyClaims,
            late: yield* cancelOf(lateRun),
          };
        })
      );

      expect(result.inOrderClaims).toEqual([result.inOrderRun]);
      expect(result.inOrder).toEqual(canceled);
      expect(result.earlyClaims).toEqual([]);
      expect(result.late).toEqual(canceled);
    });

    it("leaves alone a run whose start was received after the Cancel Event, whichever the executor delivers first", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          // Delivered in arrival order: the Cancel reaches no run yet, and
          // the start opens one it does not concern.
          const firstCancel = yield* arrive("appointment/cancelled", T0);
          const laterStart = yield* arrive("appointment/booked", at(1));
          const inOrderClaims = yield* cancel(firstCancel, at(10));
          const inOrderRun = yield* start(laterStart, at(20));

          // The start delivered first, while the Cancel's delivery was held
          // back. The Cancel, delivered later, passes over its run.
          const heldCancel = yield* arrive("appointment/cancelled", at(100));
          const earlyStart = yield* arrive("appointment/booked", at(101));
          const earlyRun = yield* start(earlyStart, at(110));
          const lateClaims = yield* cancel(heldCancel, at(120));

          return {
            inOrderClaims,
            inOrder: yield* cancelOf(inOrderRun),
            lateClaims: lateClaims.map((claim) => claim.executionId),
            early: yield* cancelOf(earlyRun),
            inOrderRun,
          };
        })
      );

      expect(result.inOrderClaims).toEqual([]);
      expect(result.inOrder).toMatchObject({ claim: "cancel" });
      // The held-back Cancel claims the in-order run, whose start was
      // received before it, and passes over the run it was received before.
      expect(result.lateClaims).toEqual([result.inOrderRun]);
      expect(result.early).toEqual(untouched);
    });

    it("matches a Cancel decision to a later start by the start's own Entity, in its own identity form", async () => {
      const connection = await seeded(await openConnection());
      const typed = { entityType: "appointment", entityId: "appt_7" };
      const result = await connection.run(
        Effect.gen(function* () {
          const typedStart = yield* arrive("appointment/booked", T0);
          const otherStart = yield* arrive("appointment/booked", T0);
          const legacyStart = yield* arrive("appointment/booked", T0);
          const cancelArrival = yield* arrive("appointment/cancelled", at(1));
          // A Cancel whose rules track the Entity, reaching runs an older
          // untracked version started by their Entity Value too.
          yield* cancel(cancelArrival, at(10), {
            ...typed,
            entityValue: "appointment_1",
          });
          return {
            typed: yield* cancelOf(yield* start(typedStart, at(20), typed)),
            other: yield* cancelOf(
              yield* start(otherStart, at(20), {
                entityType: "appointment",
                entityId: "appt_8",
              })
            ),
            legacy: yield* cancelOf(yield* start(legacyStart, at(20))),
          };
        })
      );

      expect(result.typed).toEqual(canceled);
      expect(result.other).toEqual(untouched);
      expect(result.legacy).toEqual(canceled);
    });

    it("claims a run received at the same instant as the Cancel Event in either order, and a run no Event started", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const startArrival = yield* arrive("appointment/booked", T0);
          const cancelArrival = yield* arrive("appointment/cancelled", T0);
          yield* cancel(cancelArrival, at(10));
          const sameInstant = yield* start(startArrival, at(20));
          // A manual run opened after the Cancel was received has no arrival
          // to compare, so a later Cancel claims it as it always did.
          const manual = yield* start(undefined, at(30));
          const laterCancel = yield* arrive("appointment/cancelled", T0);
          const claims = yield* cancel(laterCancel, at(40));
          return {
            sameInstant: yield* cancelOf(sameInstant),
            claims: claims.map((claim) => claim.executionId),
            manual,
          };
        })
      );

      expect(result.sameInstant).toEqual(canceled);
      expect(result.claims).toEqual([result.manual]);
    });
  });
}
