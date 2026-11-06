/**
 * The executions aggregate's producers, the writes that resolve a parked run's
 * parks and make its schedule row due: an Event or a manual resume claiming a
 * park, a Cancel claim, an Exit claim, a Migration's repin, and the replay
 * harness's `wakePark`. Each case checks that the wake and the re-queue land in
 * one write, and that a leased run is left to its release.
 *
 * Every case passes its own clock, so the due comparisons do not depend on how
 * fast the case runs.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { WaitArrival } from "@wfgraph/shared/lifecycle/wait-signal";
import {
  type PersistenceTestRegistry,
  cancelArrival,
  notYetDue,
  publishSecondVersion,
} from "#src/backend/persistence/conformance/support";
import {
  T0,
  at,
  scheduledRun,
  claimRun,
  park,
  seeded,
} from "#src/backend/persistence/conformance/schedule-support";

/** One Cancel Event for `appointment_1`, applied under the delivery id given. */
function cancelAppointment(deliveryId: string, now: Date) {
  return Effect.flatMap(ExecutionRepo, (executions) =>
    executions.requestCancelForEntity({
      workflowId: "wf_1",
      runMode: "live",
      entityValue: "appointment_1",
      eventName: "appointment/cancelled",
      payload: { reason: "customer left" },
      deliveryId,
      now,
    })
  );
}

export function describeExecutionProducerConformance({
  openConnection,
  openDatabase,
}: PersistenceTestRegistry): void {
  describe("execution producers", () => {
    it("resolves the run's other parks as an Exit in the fenced write that wins the Exit claim", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const pass = executions.fenced(fence);
          const sibling = yield* park(executionId, "wait_sibling", at(90_000));
          const won = yield* pass.requestExit({
            executionId,
            reason: "entity_condition_not_met",
            nodeId: "send",
            requestedAt: at(1_000),
          });
          const parkedAfter = yield* executions.startWait({
            side: "started",
            executionId,
            workflowId: "wf_1",
            nodeId: "wait_after",
            nodeName: "wait_after",
            workflowVersionId: "ver_1",
            waitType: "delay",
            waitUntil: at(90_000),
          });
          const lost = yield* pass.requestExit({
            executionId,
            reason: "entity_condition_not_met",
            nodeId: "other",
            requestedAt: at(2_000),
          });
          const released = yield* pass.releasePass({
            outcome: { kind: "parked" },
            now: at(3_000),
          });
          return {
            won,
            lost,
            sibling: yield* executions.findPark(sibling),
            parkedAfter,
            released,
          };
        })
      );

      expect(result.won).toMatchObject({ didWrite: true });
      expect(result.lost).toMatchObject({ didWrite: false });
      expect(result.sibling).toMatchObject({
        status: "resuming",
        wake: { kind: "exit" },
      });
      // The claim refuses every later park, so nothing new is left open.
      expect(result.parkedAfter).toBeUndefined();
      // The release reads the Exit wakes and hands the run straight back.
      expect(result.released.schedule).toMatchObject({
        state: "queued",
        wakeAt: at(3_000),
      });
    });

    it("re-queues a waiting run only when the producer's wake landed", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const consumed = yield* park(executionId, "wait_a", at(90_000));
          yield* park(executionId, "wait_b", at(120_000));
          yield* executions.wakePark({
            executionId,
            waitStateId: consumed,
            wake: { kind: "timeout" },
            now: at(500),
          });
          // The pass consumed the wake on `wait_a` and the other Wait sleeps.
          yield* executions.markWaitStatus({
            waitStateId: consumed,
            status: "timed_out",
          });
          const released = yield* executions
            .fenced(fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(1_000) });
          const late = yield* executions.wakePark({
            executionId,
            waitStateId: consumed,
            wake: { kind: "cancel" },
            now: at(2_000),
          });
          return {
            released,
            late,
            schedule: yield* executions.findSchedule({ executionId }),
          };
        })
      );

      expect(result.released.schedule.state).toBe("waiting");
      expect(result.late).toEqual({ resolved: false, requeued: false });
      expect(result.schedule).toMatchObject({
        state: "waiting",
        wakeAt: at(120_000),
      });
    });

    it("repins a sleeping run and re-queues it with a migrate wake on every park, in the repin's own write", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* publishSecondVersion;

          // A run parked on two Waits, whose pass has released it to sleep.
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const parks = [
            yield* park(executionId, "wait_a", at(90_000)),
            yield* park(executionId, "wait_b", at(120_000)),
          ];
          yield* executions
            .fenced(fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(1_000) });

          const moved = yield* executions.repinVersion({
            executionId,
            fromVersionId: "ver_1",
            toVersionId: "ver_2",
            expectedWaitStates:
              yield* executions.listWaitingStates(executionId),
            now: at(5_000),
          });
          return {
            moved,
            version: (yield* executions.findSummaryById(executionId))
              ?.workflowVersionId,
            parks: yield* Effect.forEach(parks, (waitStateId) =>
              executions.findPark(waitStateId)
            ),
            schedule: yield* executions.findSchedule({ executionId }),
          };
        })
      );

      expect(result).toMatchObject({
        moved: { moved: true, requeued: true },
        version: "ver_2",
        schedule: { state: "queued", wakeAt: at(5_000) },
      });
      expect(result.parks).toMatchObject([
        { status: "resuming", wake: { kind: "migrate" } },
        { status: "resuming", wake: { kind: "migrate" } },
      ]);
    });

    it("leaves a leased run's schedule row to its release when a repin re-queues it, and the release queues the run", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* publishSecondVersion;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const parked = yield* park(executionId, "wait_a", at(90_000));

          // The Migration lands while the pass that parked the Wait still
          // holds the lease.
          const moved = yield* executions.repinVersion({
            executionId,
            fromVersionId: "ver_1",
            toVersionId: "ver_2",
            expectedWaitStates:
              yield* executions.listWaitingStates(executionId),
            now: at(500),
          });
          const duringPass = yield* executions.findSchedule({ executionId });
          const released = yield* executions
            .fenced(fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(1_000) });
          return {
            moved,
            duringPass,
            park: yield* executions.findPark(parked),
            released,
          };
        })
      );

      expect(result.moved).toEqual({ moved: true, requeued: false });
      expect(result.duringPass).toMatchObject({
        state: "leased",
        ownerToken: expect.any(String),
      });
      expect(result.park).toMatchObject({
        status: "resuming",
        wake: { kind: "migrate" },
      });
      expect(result.released.schedule).toEqual({
        state: "queued",
        wakeAt: at(1_000),
        attempt: 0,
      });
    });

    // The TLA+ Migration model's `RepinNeedsAPark` guard: a run that is
    // running, or that holds a Wait an Event already woke, keeps the version
    // its work below that Wait runs under.

    it("refuses to repin a run that is running or holds a woken Wait, writing nothing", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* publishSecondVersion;
          const repin = (executionId: string) =>
            Effect.gen(function* () {
              return yield* executions.repinVersion({
                executionId,
                fromVersionId: "ver_1",
                toVersionId: "ver_2",
                expectedWaitStates:
                  yield* executions.listWaitingStates(executionId),
                now: at(5_000),
              });
            });

          const running = yield* scheduledRun(T0);
          const runningRefused = yield* repin(running);
          const runningSchedule = yield* executions.findSchedule({
            executionId: running,
          });

          const woken = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(woken, T0);
          const eventPark = yield* park(woken, "wait_a", at(90_000));
          const otherPark = yield* park(woken, "wait_b", at(120_000));
          yield* executions
            .fenced(fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(1_000) });
          // The Migration classified both parks before the Event arrived.
          const classified = yield* executions.listWaitingStates(woken);
          yield* executions.wakePark({
            executionId: woken,
            waitStateId: eventPark,
            wake: {
              kind: "resume",
              eventName: "appointment/approved",
              payload: {},
              deliveryId: "delivery_1",
            },
            now: at(2_000),
          });
          const wokenRefused = yield* executions.repinVersion({
            executionId: woken,
            fromVersionId: "ver_1",
            toVersionId: "ver_2",
            expectedWaitStates: classified,
            now: at(5_000),
          });

          return {
            runningRefused,
            runningVersion: (yield* executions.findSummaryById(running))
              ?.workflowVersionId,
            runningSchedule,
            wokenRefused,
            wokenVersion: (yield* executions.findSummaryById(woken))
              ?.workflowVersionId,
            eventPark: yield* executions.findPark(eventPark),
            otherPark: yield* executions.findPark(otherPark),
            wokenSchedule: yield* executions.findSchedule({
              executionId: woken,
            }),
          };
        })
      );

      expect(result.runningRefused).toEqual({ moved: false });
      expect(result.runningVersion).toBe("ver_1");
      expect(result.runningSchedule).toMatchObject({
        state: "queued",
        wakeAt: T0,
      });
      expect(result.wokenRefused).toEqual({ moved: false });
      expect(result.wokenVersion).toBe("ver_1");
      expect(result.eventPark).toMatchObject({
        status: "resuming",
        wake: { kind: "resume" },
      });
      expect(result.otherPark).toMatchObject({ status: "waiting", wake: null });
      expect(result.wokenSchedule).toMatchObject({
        state: "queued",
        wakeAt: at(2_000),
      });
    });

    it("writes an Event's claim and its wake in one write, re-queueing a sleeping run and leaving a leased one to its release", async () => {
      const connection = await seeded(await openConnection());
      const arrival = {
        eventName: "appointment/approved",
        payload: { approved: true },
        deliveryId: "delivery_1",
      } as const;
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;

          // A run whose pass released it to sleep on one park.
          const sleeping = yield* scheduledRun(T0);
          const sleepingPass = yield* claimRun(sleeping, T0);
          const sleepingPark = yield* park(sleeping, "wait_a", at(90_000));
          yield* executions
            .fenced(sleepingPass.fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(1_000) });
          const byId = yield* executions.claimWaitingStateById({
            waitStateId: sleepingPark,
            resumeToken: `${sleeping}-wait_a`,
            eventName: arrival.eventName,
            arrival,
            now: at(2_000),
          });
          const secondDelivery = yield* executions.claimWaitingStateById({
            waitStateId: sleepingPark,
            resumeToken: `${sleeping}-wait_a`,
            eventName: arrival.eventName,
            arrival: { ...arrival, deliveryId: "delivery_2" },
            now: at(2_500),
          });
          // Read before the next claim, which would lease this due row too.
          const sleepingSchedule = yield* executions.findSchedule({
            executionId: sleeping,
          });

          // A run whose pass still holds its lease when the Event arrives.
          const leased = yield* scheduledRun(T0);
          const leasedPass = yield* claimRun(leased, at(3_000));
          const leasedPark = yield* park(leased, "wait_b", at(90_000));
          const byToken = yield* executions.claimWaitingStateByToken({
            resumeToken: `${leased}-wait_b`,
            arrival,
            now: at(4_000),
          });
          const duringPass = yield* executions.findSchedule({
            executionId: leased,
          });
          const released = yield* executions
            .fenced(leasedPass.fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(5_000) });

          return {
            byId,
            secondDelivery,
            sleepingPark: yield* executions.findPark(sleepingPark),
            sleepingSchedule,
            byToken,
            leasedPark: yield* executions.findPark(leasedPark),
            duringPass,
            released: released.schedule,
          };
        })
      );

      const wake = {
        kind: "resume",
        eventName: arrival.eventName,
        payload: arrival.payload,
        deliveryId: arrival.deliveryId,
      };
      expect(result.byId).toMatchObject({
        waitState: { status: "resuming" },
        requeued: true,
      });
      expect(result.secondDelivery).toBeNull();
      expect(result.sleepingPark).toMatchObject({ status: "resuming", wake });
      expect(result.sleepingSchedule).toMatchObject({
        state: "queued",
        wakeAt: at(2_000),
      });
      expect(result.byToken).toMatchObject({ requeued: false });
      expect(result.leasedPark).toMatchObject({ status: "resuming", wake });
      expect(result.duringPass).toMatchObject({ state: "leased" });
      expect(result.released).toEqual({
        state: "queued",
        wakeAt: at(5_000),
        attempt: 0,
      });
    });

    // The TLA+ Delivery model's `EachWaitWokenOnce` and
    // `NoSecondWaitFromOneArrival`: a delivery that crashed after its claim
    // committed runs again and must count the Wait it already woke, without
    // waking it a second time, so it never treats its own run as unwoken.

    it("answers a delivery's retry of its own committed claim as claimed, writing nothing, and refuses every other arrival", async () => {
      const connection = await seeded(await openConnection());
      const arrival = {
        eventName: "appointment/approved",
        payload: { approved: true },
        deliveryId: "delivery_1",
      } as const;
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const pass = yield* claimRun(executionId, T0);
          const waitStateId = yield* park(executionId, "wait_a", at(90_000));
          yield* executions
            .fenced(pass.fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(1_000) });
          const claimFor = (input: { arrival: WaitArrival; now: Date }) =>
            executions.claimWaitingStateById({
              waitStateId,
              resumeToken: `${executionId}-wait_a`,
              eventName: arrival.eventName,
              arrival: input.arrival,
              now: input.now,
            });

          const first = yield* claimFor({ arrival, now: at(2_000) });
          const afterFirst = {
            row: yield* executions.findWaitStateById(waitStateId),
            park: yield* executions.findPark(waitStateId),
            schedule: yield* executions.findSchedule({ executionId }),
          };
          const retry = yield* claimFor({
            arrival: { ...arrival, payload: { approved: false } },
            now: at(3_000),
          });
          const otherDelivery = yield* claimFor({
            arrival: { ...arrival, deliveryId: "delivery_2" },
            now: at(3_500),
          });
          const noDelivery = yield* claimFor({
            arrival: {
              eventName: arrival.eventName,
              payload: arrival.payload,
            },
            now: at(3_600),
          });
          const afterRetries = {
            row: yield* executions.findWaitStateById(waitStateId),
            park: yield* executions.findPark(waitStateId),
            schedule: yield* executions.findSchedule({ executionId }),
          };
          return {
            waitStateId,
            first,
            afterFirst,
            retry,
            otherDelivery,
            noDelivery,
            afterRetries,
          };
        })
      );

      expect(result.first).toMatchObject({
        waitState: { id: result.waitStateId, status: "resuming" },
        requeued: true,
      });
      expect(result.afterFirst.schedule).toMatchObject({
        state: "queued",
        wakeAt: at(2_000),
      });
      expect(result.retry).toEqual({
        waitState: result.afterFirst.row,
        requeued: false,
      });
      expect(result.otherDelivery).toBeNull();
      expect(result.noDelivery).toBeNull();
      expect(result.afterRetries).toEqual(result.afterFirst);
      expect(result.afterRetries.park).toMatchObject({
        wake: { kind: "resume", payload: { approved: true } },
      });
    });

    // The TLA+ Migration model's `EventReplacesMigrateWake`: an Event that
    // arrives while a Migration's wake is still pending takes the park, so the
    // run is not lost to the Migration, and the next pass resumes the Wait on
    // the Event under the version the run was moved to.

    it("lets an Event's claim replace a pending migrate wake, and refuses a second Event", async () => {
      const connection = await seeded(await openConnection());
      const arrival = {
        eventName: "appointment/approved",
        payload: {},
      } as const;
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* publishSecondVersion;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const migrated = yield* park(executionId, "wait_a", at(90_000));
          yield* executions
            .fenced(fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(100) });
          yield* executions.repinVersion({
            executionId,
            fromVersionId: "ver_1",
            toVersionId: "ver_2",
            expectedWaitStates:
              yield* executions.listWaitingStates(executionId),
            now: at(200),
          });

          const replacesMigrate = yield* executions.claimWaitingStateById({
            waitStateId: migrated,
            resumeToken: `${executionId}-wait_a`,
            eventName: arrival.eventName,
            arrival,
            now: at(300),
          });
          const secondEvent = yield* executions.claimWaitingStateByToken({
            resumeToken: `${executionId}-wait_a`,
            arrival,
            now: at(400),
          });
          return {
            replacesMigrate,
            migratedPark: yield* executions.findPark(migrated),
            secondEvent,
            version: (yield* executions.findSummaryById(executionId))
              ?.workflowVersionId,
          };
        })
      );

      expect(result.replacesMigrate).toMatchObject({
        waitState: { status: "resuming" },
        // The repin already re-queued the run, so the claim moved nothing.
        requeued: false,
      });
      expect(result.migratedPark).toMatchObject({
        status: "resuming",
        wake: { kind: "resume", eventName: arrival.eventName },
      });
      expect(result.secondEvent).toBeNull();
      expect(result.version).toBe("ver_2");
    });

    it("resolves every park a Cancel claim finds with a cancel wake and re-queues the run, in the claim's own write", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          /** Opens a run about `appointment_1` with a schedule row due at `T0`. */
          const entityRun = Effect.gen(function* () {
            const started = yield* executions.startForEntity({
              execution: {
                workflowId: "wf_1",
                workflowVersionId: "ver_1",
                startSource: "event",
                runMode: "live",
                entityValue: "appointment_1",
                input: {},
              },
              concurrency: "unlimited",
              supersededReason: "newer start",
              startedEntry: notYetDue.startedEntry,
              now: T0,
            });
            if (started.status !== "started") throw new Error("Start refused");
            return started.execution.id;
          });

          // A run whose pass released it to sleep on two parks.
          const sleeping = yield* entityRun;
          const sleepingPass = yield* claimRun(sleeping, T0);
          const sleepingParks = [
            yield* park(sleeping, "wait_a", at(90_000)),
            yield* park(sleeping, "wait_b", at(120_000)),
          ];
          yield* executions
            .fenced(sleepingPass.fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(1_000) });

          // A run whose pass still holds its lease, parked on one Wait.
          const leased = yield* entityRun;
          yield* claimRun(leased, at(1_500));
          const leasedPark = yield* park(leased, "wait_c", at(90_000));

          // Each call is a Cancel Event of its own, with an inbox row of its own.
          const cancel = (now: Date) =>
            Effect.flatMap(cancelArrival(), (deliveryId) =>
              executions.requestCancelForEntity({
                workflowId: "wf_1",
                runMode: "live",
                entityValue: "appointment_1",
                eventName: "appointment/cancelled",
                payload: { reason: "customer left" },
                deliveryId,
                now,
              })
            );
          const claims = yield* cancel(at(2_000));
          const repeated = yield* cancel(at(3_000));

          return {
            sleeping,
            leased,
            claims,
            repeated,
            parks: yield* Effect.forEach(
              [...sleepingParks, leasedPark],
              (waitStateId) => executions.findPark(waitStateId)
            ),
            sleepingSchedule: yield* executions.findSchedule({
              executionId: sleeping,
            }),
            leasedSchedule: yield* executions.findSchedule({
              executionId: leased,
            }),
            claim: (yield* executions.findTerminationState(sleeping))?.claim,
          };
        })
      );

      expect(result.claims).toEqual(
        expect.arrayContaining([
          {
            kind: "claimed",
            executionId: result.sleeping,
            resolvedParks: 2,
            requeued: true,
          },
          {
            kind: "claimed",
            executionId: result.leased,
            resolvedParks: 1,
            requeued: false,
          },
        ])
      );
      expect(result.claims).toHaveLength(2);
      // The first Cancel Event owns the runs, so a second claims nothing.
      expect(result.repeated).toEqual([]);
      expect(result.parks).toMatchObject([
        { status: "resuming", wake: { kind: "cancel" } },
        { status: "resuming", wake: { kind: "cancel" } },
        { status: "resuming", wake: { kind: "cancel" } },
      ]);
      expect(result.sleepingSchedule).toMatchObject({
        state: "queued",
        wakeAt: at(2_000),
      });
      // A leased run is re-queued by its release, which reads the wake.
      expect(result.leasedSchedule).toMatchObject({ state: "leased" });
      expect(result.claim).toMatchObject({
        kind: "cancel",
        eventName: "appointment/cancelled",
      });
    });

    it("answers a delivery's retried Cancel claim with the runs its first attempt claimed, writing nothing, and leaves them out of another delivery's answer", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "event",
              runMode: "live",
              entityValue: "appointment_1",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
            startedEntry: notYetDue.startedEntry,
            now: T0,
          });
          if (started.status !== "started") throw new Error("Start refused");
          const cancel = (deliveryId: string, now: Date) =>
            executions.requestCancelForEntity({
              workflowId: "wf_1",
              runMode: "live",
              entityValue: "appointment_1",
              eventName: "appointment/cancelled",
              payload: { reason: "customer left" },
              deliveryId,
              now,
            });
          const arrival = yield* cancelArrival();
          const otherArrival = yield* cancelArrival();
          const first = yield* cancel(arrival, at(1_000));
          const scheduleAfterFirst = yield* executions.findSchedule({
            executionId: started.execution.id,
          });
          const retried = yield* cancel(arrival, at(2_000));
          const other = yield* cancel(otherArrival, at(3_000));
          return {
            executionId: started.execution.id,
            first,
            retried,
            other,
            scheduleAfterFirst,
            scheduleAfterRetry: yield* executions.findSchedule({
              executionId: started.execution.id,
            }),
            termination: yield* executions.findTerminationState(
              started.execution.id
            ),
            timeline: yield* executions.listEvents(started.execution.id),
          };
        })
      );

      // The run was already due, so the claim made nothing due.
      expect(result.first).toEqual([
        {
          kind: "claimed",
          executionId: result.executionId,
          resolvedParks: 0,
          requeued: false,
        },
      ]);
      expect(result.retried).toEqual([
        { kind: "claimed_earlier", executionId: result.executionId },
      ]);
      expect(result.other).toEqual([]);
      // The retry wrote nothing: the run keeps the first claim's time and the
      // schedule row the first claim made due.
      expect(result.scheduleAfterRetry).toEqual(result.scheduleAfterFirst);
      expect(result.termination?.claim).toMatchObject({
        kind: "cancel",
        eventName: "appointment/cancelled",
      });
      // The claim wrote its timeline entry in its own transaction, once.
      expect(
        result.timeline.filter(
          (entry) => entry.eventType === "run_cancel_requested"
        )
      ).toMatchObject([
        {
          message: "Cancellation requested by appointment/cancelled",
          metadata: { eventName: "appointment/cancelled", parkedWaits: 0 },
        },
      ]);
    });

    it("answers a retried Cancel from its recorded decision, leaving a run that opened after the first attempt unclaimed, and drops the decision with its inbox row", async () => {
      const database = await openDatabase();
      const connection = await seeded(await database.open());

      const retried = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          // The first attempt finds no run in flight, and records that it
          // decided so.
          const arrival = yield* cancelArrival(T0);
          const first = yield* cancelAppointment(arrival, at(1_000));
          // A run opens after the first attempt committed, and the delivery
          // is retried, as after a crash before its step's memo row.
          const late = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "event",
              runMode: "live",
              entityValue: "appointment_1",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
            startedEntry: notYetDue.startedEntry,
            now: at(2_000),
          });
          if (late.status !== "started") throw new Error("Start refused");
          return {
            arrival,
            first,
            again: yield* cancelAppointment(arrival, at(3_000)),
            lateId: late.execution.id,
            lateCancel: yield* executions.findPendingCancel(late.execution.id),
            lateTimeline: yield* executions.listEvents(late.execution.id),
          };
        })
      );

      expect(retried.first).toEqual([]);
      expect(retried.again).toEqual([]);
      expect(retried.lateCancel).toBeNull();
      expect(
        retried.lateTimeline.map((entry) => entry.eventType)
      ).not.toContain("run_cancel_requested");

      // The arrival settles and the sweep deletes its row on this connection,
      // and the decision goes with it by cascade. A host row inserted under
      // the same id is a new arrival, whose Cancel claims the run.
      await database.execute({
        postgresql: `update workflow_event_inbox set status = 'delivered', settled_at = now() where id = '${retried.arrival}'`,
        sqlite: `update workflow_event_inbox set status = 'delivered', settled_at = 0 where id = '${retried.arrival}'`,
      });
      const swept = await connection.run(
        Effect.flatMap(ExecutionRepo, (executions) =>
          executions.sweepSettledInbox({ olderThan: at(5_000), limit: 10 })
        )
      );
      await database.execute(
        `insert into workflow_event_inbox (id, name, data) values ('${retried.arrival}', 'appointment/cancelled', '{}')`
      );
      const reused = await connection.run(
        cancelAppointment(retried.arrival, at(6_000))
      );

      expect(swept).toBe(1);
      expect(reused).toMatchObject([
        { kind: "claimed", executionId: retried.lateId },
      ]);
    });
  });
}
