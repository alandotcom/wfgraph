import { assert, describe, layer } from "@effect/vitest";
import { beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import { SilentAppLoggerLayer } from "#src/backend/lib/effect/test-layers";
import { applyLifecycleRules } from "#src/backend/services/workflows/lifecycle/deliver-event";
import {
  appointmentCreated,
  catalogLayer,
  filterOn,
  filteredRules,
  guardedRules,
  recordAuditEventMock,
  resetGuardedStartMocks,
  resolveEntityMock,
  selectEntityIdMock,
  sendCancelRequestedMock,
  startForEntityMock,
  startRules,
  subscriber,
  videoPayload,
  workflowWith,
} from "#src/backend/services/workflows/lifecycle/deliver-event-admission-test-support";

/**
 * What a Start Filter does to an arrival, at the one seam that decides it.
 *
 * Separate from `deliver-event.test.ts` because the question is separate: that
 * file asks what the Lifecycle Rules do with an Event, and these cases ask what
 * happens between the start role being confirmed and Concurrency being
 * consulted (ADR-0016). Admission Entity Eligibility, its delivery-retry
 * races, and typed-identity cancellation are
 * `deliver-event.admission.test.ts`, which shares this file's fixture through
 * `deliver-event-admission-test-support.ts`.
 */

beforeEach(() => {
  resetGuardedStartMocks();
});

describe("applyLifecycleRules and Start Filters", () => {
  layer(Layer.merge(SilentAppLoggerLayer, catalogLayer))((it) => {
    it.effect("starts when the arrival satisfies the Start Filter", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: videoPayload,
        }).pipe(
          Effect.provide(
            workflowWith(
              filteredRules(
                filterOn({
                  path: "appointment.channel",
                  fieldType: "string",
                  operator: "equals",
                  value: "video",
                })
              )
            )
          )
        );

        assert.strictEqual(outcome.kind, "started");
      })
    );

    it.effect("opens no run when the arrival fails the Start Filter", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: videoPayload,
          deliveryId: "evt_arrival",
        }).pipe(
          Effect.provide(
            workflowWith(
              filteredRules(
                filterOn({
                  path: "appointment.channel",
                  fieldType: "string",
                  operator: "equals",
                  value: "in_person",
                })
              )
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "refused",
          workflowId: "wf_1",
          reason: "start_filter_not_met",
        });
        assert.strictEqual(startForEntityMock.mock.calls.length, 0);
      })
    );

    // A refusal nobody can read is the class of invisible behaviour ADR-0007
    // exists to remove, and the Refused Starts panel reads this row.
    it.effect("records the refusal against the workflow", () =>
      Effect.gen(function* () {
        yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: videoPayload,
          deliveryId: "evt_arrival",
        }).pipe(
          Effect.provide(
            workflowWith(
              filteredRules(
                filterOn({
                  path: "appointment.channel",
                  fieldType: "string",
                  operator: "equals",
                  value: "in_person",
                })
              )
            )
          )
        );

        const audit = recordAuditEventMock.mock.calls[0]?.[0];
        assert.strictEqual(audit?.eventType, "run_refused");
        assert.include(audit?.message ?? "", "start filter");
        assert.deepInclude(audit?.metadata, {
          reason: "start_filter_not_met",
          eventName: "app/appointment.created",
          deliveryId: "evt_arrival",
        });
      })
    );

    // The whole of why the filter is read here rather than by a Condition node
    // behind the Started outlet: by the time that node runs, the arrival has
    // already displaced the run that was in flight.
    it.effect(
      "leaves a newest-wins run in flight when the arrival fails the filter",
      () =>
        Effect.gen(function* () {
          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
          }).pipe(
            Effect.provide(
              workflowWith(
                filteredRules(
                  filterOn({
                    path: "appointment.channel",
                    fieldType: "string",
                    operator: "equals",
                    value: "in_person",
                  }),
                  "newest-wins"
                )
              )
            )
          );

          assert.strictEqual(outcome.kind, "refused");
          // `startForEntity` is where a newest-wins start supersedes, so never
          // reaching it is the assertion: nothing was displaced.
          assert.strictEqual(startForEntityMock.mock.calls.length, 0);
          assert.strictEqual(sendCancelRequestedMock.mock.calls.length, 0);
        })
    );

    // The payload comes from outside and may carry anything, so a field of the
    // wrong type is an arrival the filter does not admit, not a reason to start.
    it.effect("opens no run when the Start Filter cannot be evaluated", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: videoPayload,
        }).pipe(
          Effect.provide(
            workflowWith(
              filteredRules(
                filterOn({
                  path: "appointment.seats",
                  fieldType: "number",
                  operator: "greater_than",
                  value: 1,
                })
              )
            )
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "refused",
          workflowId: "wf_1",
          reason: "start_filter_unevaluable",
        });
        assert.strictEqual(startForEntityMock.mock.calls.length, 0);
        assert.strictEqual(
          recordAuditEventMock.mock.calls[0]?.[0].eventType,
          "run_refused"
        );
      })
    );

    it.effect(
      "runs the Start Filter before selecting or resolving the tracked Entity",
      () =>
        Effect.gen(function* () {
          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
          }).pipe(
            Effect.provide(
              workflowWith(
                guardedRules({
                  checkpoints: ["before-execution"],
                  startFilter: filterOn({
                    path: "appointment.channel",
                    fieldType: "string",
                    operator: "equals",
                    value: "in_person",
                  }),
                })
              )
            )
          );

          assert.strictEqual(outcome.kind, "refused");
          assert.strictEqual(selectEntityIdMock.mock.calls.length, 0);
          assert.strictEqual(resolveEntityMock.mock.calls.length, 0);
          assert.strictEqual(startForEntityMock.mock.calls.length, 0);
        })
    );

    it.effect(
      "leaves an Event with no Start Filter starting every arrival",
      () =>
        Effect.gen(function* () {
          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
          }).pipe(Effect.provide(workflowWith(startRules)));

          assert.strictEqual(outcome.kind, "started");
        })
    );
  });
});
