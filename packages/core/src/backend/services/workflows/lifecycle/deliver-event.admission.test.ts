import { assert, describe, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { beforeEach, vi } from "vitest";
import { Cause, Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { serializeConditionModel } from "@wfgraph/shared/conditions/conditions";
import type { EntityEligibilityReason } from "@wfgraph/shared/lifecycle/execution-contracts";
import { SilentAppLoggerLayer } from "#src/backend/lib/effect/test-layers";
import { applyLifecycleRules } from "#src/backend/services/workflows/lifecycle/deliver-event";
import {
  appointmentCreated,
  appointmentCanceled,
  appointmentEntity,
  catalogLayer,
  filterOn,
  findAdmissionRefusalMock,
  guardedCancelRules,
  guardedRules,
  recordAdmissionRefusalMock,
  recordAuditEventMock,
  requestCancelForEntityMock,
  resetGuardedStartMocks,
  resolveEntityMock,
  selectCanceledEntityIdMock,
  sendRunRequestedMock,
  startForEntityMock,
  subscriber,
  videoPayload,
  winnerOutcome,
  workflowWith,
} from "#src/backend/services/workflows/lifecycle/deliver-event-admission-test-support";

/**
 * Admission Entity Eligibility: what a guarded Start or Cancel does with the
 * tracked Entity's current State, at the "before-execution" and "before-node"
 * checkpoints (ADR-0016). Shares its fixture with
 * `deliver-event.start-filters.test.ts` through
 * `deliver-event-admission-test-support.ts`.
 *
 * The three delivery-retry cases below (a racing admission refusal, and the
 * two commits that race ahead of it) stay here rather than in
 * `deliver-event.recovery.test.ts`: they exercise `recordAdmissionRefusal`'s
 * own race-detection return value, which only a guarded start reaches, not
 * `answerFromCommittedDecision`'s `findByDelivery` read that file's cases are
 * about. The one delivery-retry case that does read `findByDelivery` moved to
 * `deliver-event.recovery.test.ts` instead, beside the cases already shaped
 * the same way.
 */

// Only the timeout case below parks a fiber on the resolver and needs the
// event loop to turn once before advancing the `TestClock`.
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setImmediate(resolve))
);

beforeEach(() => {
  resetGuardedStartMocks();
});

describe("applyLifecycleRules and Admission Entity Eligibility", () => {
  layer(Layer.merge(SilentAppLoggerLayer, catalogLayer))((it) => {
    it.effect(
      "refuses an ineligible Entity before Concurrency without persisting its state or id",
      () =>
        Effect.gen(function* () {
          resolveEntityMock.mockResolvedValue({
            status: "cancelled",
            remindersEnabled: false,
          });

          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
            deliveryId: "evt_entity_refusal",
          }).pipe(
            Effect.provide(
              workflowWith(guardedRules({ checkpoints: ["before-execution"] }))
            )
          );

          assert.deepStrictEqual(outcome, {
            kind: "refused",
            workflowId: "wf_1",
            reason: "entity_condition_not_met",
          });
          assert.strictEqual(resolveEntityMock.mock.calls.length, 1);
          assert.strictEqual(startForEntityMock.mock.calls.length, 0);
          const audit = recordAdmissionRefusalMock.mock.calls[0]?.[0];
          assert.deepInclude(audit?.metadata, {
            reason: "entity_condition_not_met",
            entityType: "appointment",
            checkpoint: "before-execution",
            deliveryId: "evt_entity_refusal",
          });
          assert.notProperty(audit?.metadata ?? {}, "entityId");
          assert.notProperty(audit?.metadata ?? {}, "state");
        })
    );

    it.effect(
      "replays a durable admission refusal without resolving again",
      () =>
        Effect.gen(function* () {
          let storedReason: EntityEligibilityReason | null = null;
          findAdmissionRefusalMock.mockImplementation(() =>
            Effect.succeed(storedReason)
          );
          recordAdmissionRefusalMock.mockImplementation((input) =>
            Effect.sync(() => {
              storedReason = input.reason;
              return { kind: "refused" as const, reason: input.reason };
            })
          );
          resolveEntityMock
            .mockResolvedValueOnce({
              status: "cancelled",
              remindersEnabled: false,
            })
            .mockResolvedValue({
              status: "scheduled",
              remindersEnabled: true,
            });
          const delivery = {
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
            deliveryId: "evt_replayed_refusal",
          };
          const services = workflowWith(
            guardedRules({ checkpoints: ["before-execution"] })
          );

          const first = yield* applyLifecycleRules(delivery).pipe(
            Effect.provide(services)
          );
          const replay = yield* applyLifecycleRules(delivery).pipe(
            Effect.provide(services)
          );

          assert.strictEqual(first.kind, "refused");
          assert.strictEqual(replay.kind, "refused");
          assert.strictEqual(resolveEntityMock.mock.calls.length, 1);
          assert.strictEqual(recordAdmissionRefusalMock.mock.calls.length, 1);
          assert.strictEqual(startForEntityMock.mock.calls.length, 0);
        })
    );

    // The winner was already sent by the attempt that committed it, so the
    // replayed start through `startWithConcurrency` answers from its row and
    // sends nothing a second time.
    it.effect("returns the start that won a racing admission refusal", () =>
      Effect.gen(function* () {
        resolveEntityMock.mockResolvedValue({
          status: "cancelled",
          remindersEnabled: false,
        });
        recordAdmissionRefusalMock.mockImplementation(() =>
          Effect.succeed({ kind: "started", executionId: "exec_winner" })
        );
        startForEntityMock.mockImplementation(() =>
          Effect.succeed(
            winnerOutcome({
              deliveryId: "evt_racing_start",
              enqueuedAt: new Date("2026-03-01T00:00:01.000Z"),
            })
          )
        );

        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: videoPayload,
          deliveryId: "evt_racing_start",
        }).pipe(
          Effect.provide(
            workflowWith(guardedRules({ checkpoints: ["before-execution"] }))
          )
        );

        assert.deepStrictEqual(outcome, {
          kind: "started",
          workflowId: "wf_1",
          executionId: "exec_winner",
          supersededExecutionIds: [],
          failedToSupersede: [],
        });
        assert.strictEqual(sendRunRequestedMock.mock.calls.length, 0);
      })
    );

    // Another attempt of the same delivery found the Entity eligible and
    // committed the Execution after this attempt's `findByDelivery` read came
    // back empty. This attempt reads the Entity as ineligible, and the delivery
    // still has to reach the bus, or the row stays in flight with no run.
    it.effect(
      "sends the Execution a concurrent attempt committed when this attempt finds the Entity ineligible",
      () =>
        Effect.gen(function* () {
          resolveEntityMock.mockResolvedValue({
            status: "cancelled",
            remindersEnabled: false,
          });
          recordAdmissionRefusalMock.mockImplementation(() =>
            Effect.succeed({ kind: "started", executionId: "exec_winner" })
          );
          startForEntityMock.mockImplementation(() =>
            Effect.succeed(
              winnerOutcome({ deliveryId: "evt_crashed", enqueuedAt: null })
            )
          );

          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
            deliveryId: "evt_crashed",
          }).pipe(
            Effect.provide(
              workflowWith(guardedRules({ checkpoints: ["before-execution"] }))
            )
          );

          assert.deepStrictEqual(outcome, {
            kind: "started",
            workflowId: "wf_1",
            executionId: "exec_winner",
            supersededExecutionIds: [],
            failedToSupersede: [],
          });
          assert.strictEqual(startForEntityMock.mock.calls.length, 1);
          assert.deepInclude(startForEntityMock.mock.calls[0]?.[0].execution, {
            deliveryId: "evt_crashed",
            entityType: "appointment",
            entityId: "appt_8813",
          });
          assert.deepStrictEqual(
            sendRunRequestedMock.mock.calls.map(([data]) => data),
            [{ executionId: "exec_winner" }]
          );
        })
    );

    it.effect("distinguishes a missing Entity from an ineligible one", () =>
      Effect.gen(function* () {
        resolveEntityMock.mockResolvedValue(null);

        const outcome = yield* applyLifecycleRules({
          subscriber: subscriber(),
          event: appointmentCreated,
          payload: videoPayload,
        }).pipe(
          Effect.provide(
            workflowWith(guardedRules({ checkpoints: ["before-execution"] }))
          )
        );

        assert.strictEqual(outcome.kind, "refused");
        if (outcome.kind === "refused") {
          assert.strictEqual(outcome.reason, "entity_not_found");
        }
        assert.strictEqual(startForEntityMock.mock.calls.length, 0);
      })
    );

    it.effect(
      "persists typed identity and skips the resolver for a node-only guard",
      () =>
        Effect.gen(function* () {
          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
          }).pipe(
            Effect.provide(
              workflowWith(guardedRules({ checkpoints: ["before-node"] }))
            )
          );

          assert.strictEqual(outcome.kind, "started");
          assert.strictEqual(resolveEntityMock.mock.calls.length, 0);
          assert.deepInclude(startForEntityMock.mock.calls[0]?.[0].execution, {
            entityType: "appointment",
            entityId: "appt_8813",
          });
          assert.notProperty(
            startForEntityMock.mock.calls[0]?.[0].execution ?? {},
            "entityValue"
          );
        })
    );

    it.effect(
      "accepts a validated undefined value when the Event selector supports it",
      () =>
        Effect.gen(function* () {
          const selectUndefined = vi.fn((value: unknown) => {
            assert.strictEqual(value, undefined);
            return "appt_constant";
          });
          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: {
              name: appointmentCreated.name,
              entityBindings: {
                appointment: {
                  entity: appointmentEntity,
                  selectEntityId: selectUndefined,
                },
              },
              validatedPayload: undefined,
            },
            payload: videoPayload,
          }).pipe(
            Effect.provide(
              workflowWith(guardedRules({ checkpoints: ["before-node"] }))
            )
          );

          assert.strictEqual(outcome.kind, "started");
          assert.strictEqual(selectUndefined.mock.calls.length, 1);
          assert.strictEqual(
            startForEntityMock.mock.calls[0]?.[0].execution.entityId,
            "appt_constant"
          );
        })
    );

    it.effect(
      "starts with typed identity only after admission Eligibility passes",
      () =>
        Effect.gen(function* () {
          const outcome = yield* applyLifecycleRules({
            subscriber: subscriber(),
            event: appointmentCreated,
            payload: videoPayload,
          }).pipe(
            Effect.provide(
              workflowWith(guardedRules({ checkpoints: ["before-execution"] }))
            )
          );

          assert.strictEqual(outcome.kind, "started");
          assert.strictEqual(resolveEntityMock.mock.calls.length, 1);
          assert.deepInclude(startForEntityMock.mock.calls[0]?.[0].execution, {
            entityType: "appointment",
            entityId: "appt_8813",
          });
        })
    );

    it.effect(
      "leaves a resolver failure operational and opens no Execution",
      () =>
        Effect.gen(function* () {
          resolveEntityMock.mockRejectedValue(new Error("host unavailable"));

          const exit = yield* Effect.exit(
            applyLifecycleRules({
              subscriber: subscriber(),
              event: appointmentCreated,
              payload: videoPayload,
            }).pipe(
              Effect.provide(
                workflowWith(
                  guardedRules({ checkpoints: ["before-execution"] })
                )
              )
            )
          );

          assert.strictEqual(exit._tag, "Failure");
          assert.strictEqual(startForEntityMock.mock.calls.length, 0);
          assert.strictEqual(recordAuditEventMock.mock.calls.length, 0);
        })
    );

    // `is_not_set` on a field the State schema no longer declares evaluates true
    // against any state, so evaluating it would admit the run.
    it.effect(
      "fails admission on a stored rule the current State schema refuses, without resolving",
      () =>
        Effect.gen(function* () {
          const rules = guardedRules({ checkpoints: ["before-execution"] });
          const guardedOnRemovedField = serializeConditionModel({
            version: 2,
            groupLogic: "and",
            groups: [
              {
                id: "group",
                logic: "and",
                conditions: [
                  {
                    id: "archived",
                    field: "archivedAt",
                    fieldType: "string",
                    operator: "is_not_set",
                  },
                ],
              },
            ],
          });

          const exit = yield* Effect.exit(
            applyLifecycleRules({
              subscriber: subscriber(),
              event: appointmentCreated,
              payload: videoPayload,
            }).pipe(
              Effect.provide(
                workflowWith({
                  ...rules,
                  entityEligibility: {
                    condition: guardedOnRemovedField,
                    checkpoints: ["before-execution"],
                  },
                })
              )
            )
          );

          assert.strictEqual(exit._tag, "Failure");
          if (exit._tag === "Failure") {
            const failure = Option.getOrUndefined(
              Cause.findErrorOption(exit.cause)
            );
            assert.include(
              String(failure?.cause),
              'reads "archivedAt", which Entity "appointment" does not declare'
            );
          }
          assert.strictEqual(resolveEntityMock.mock.calls.length, 0);
          assert.strictEqual(startForEntityMock.mock.calls.length, 0);
          assert.strictEqual(recordAdmissionRefusalMock.mock.calls.length, 0);
          assert.strictEqual(recordAuditEventMock.mock.calls.length, 0);
        })
    );

    it.effect(
      "times out an admission resolver without opening or refusing an Execution",
      () =>
        Effect.gen(function* () {
          resolveEntityMock.mockImplementation(
            () =>
              new Promise<{ status: string; remindersEnabled: boolean } | null>(
                () => undefined
              )
          );

          const fiber = yield* Effect.forkChild(
            Effect.exit(
              applyLifecycleRules({
                subscriber: subscriber(),
                event: appointmentCreated,
                payload: videoPayload,
              }).pipe(
                Effect.provide(
                  workflowWith(
                    guardedRules({ checkpoints: ["before-execution"] })
                  )
                )
              )
            )
          );
          yield* settle;
          yield* TestClock.adjust("10 seconds");

          const exit = yield* Fiber.join(fiber);
          assert.strictEqual(exit._tag, "Failure");
          assert.strictEqual(startForEntityMock.mock.calls.length, 0);
          assert.strictEqual(recordAuditEventMock.mock.calls.length, 0);
          assert.strictEqual(recordAdmissionRefusalMock.mock.calls.length, 0);
        })
    );

    it.effect("matches guarded cancellations by typed Entity identity", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: { ...subscriber(), roles: ["cancel"] },
          event: appointmentCanceled,
          payload: { appointmentId: "appt_8813", reason: "host request" },
        }).pipe(Effect.provide(workflowWith(guardedCancelRules())));

        assert.strictEqual(outcome.kind, "canceled");
        assert.deepInclude(requestCancelForEntityMock.mock.calls[0]?.[0], {
          workflowId: "wf_1",
          entityType: "appointment",
          entityId: "appt_8813",
        });
        assert.notProperty(
          requestCancelForEntityMock.mock.calls[0]?.[0] ?? {},
          "entityValue"
        );
      })
    );

    it.effect("runs a guarded Cancel Filter before its Entity selector", () =>
      Effect.gen(function* () {
        const outcome = yield* applyLifecycleRules({
          subscriber: { ...subscriber(), roles: ["cancel"] },
          event: appointmentCanceled,
          payload: { appointmentId: "appt_8813", reason: "host request" },
        }).pipe(
          Effect.provide(
            workflowWith(
              guardedCancelRules(
                filterOn({
                  path: "reason",
                  fieldType: "string",
                  operator: "equals",
                  value: "duplicate",
                })
              )
            )
          )
        );

        assert.strictEqual(outcome.kind, "refused");
        assert.strictEqual(selectCanceledEntityIdMock.mock.calls.length, 0);
        assert.strictEqual(requestCancelForEntityMock.mock.calls.length, 0);
      })
    );
  });
});
