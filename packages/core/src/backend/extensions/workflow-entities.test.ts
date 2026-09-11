import { it as effectIt } from "@effect/vitest";
import { describe, expect, it, vi } from "vitest";
import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { defineEntity } from "#src/backend/extensions/define-entity";
import { defineEvent } from "#src/backend/extensions/define-event";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { createWorkflowEntities } from "#src/backend/extensions/workflow-entities";

function eligibleWhenActive(): string {
  return JSON.stringify({
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group",
        logic: "and",
        conditions: [
          {
            id: "active",
            field: "active",
            fieldType: "boolean",
            operator: "is_true",
          },
        ],
      },
    ],
  });
}

function surface(
  resolve: (input: {
    entityId: string;
  }) => { active: boolean } | null | Promise<{ active: boolean } | null>
) {
  const entity = defineEntity({
    type: "appointment",
    label: "Appointment",
    state: Schema.Struct({ active: Schema.Boolean }),
    resolve,
  });
  const event = defineEvent({
    name: "appointment.started",
    schema: Schema.Struct({ appointmentId: Schema.String }),
    entities: {
      appointment: {
        entity,
        selectEntityId: (payload) => payload.appointmentId,
      },
    },
  });
  return createWorkflowEntities(assembleExtensions({ events: [event] }));
}

const settle = Effect.promise(
  () => new Promise<void>((resolve) => setImmediate(resolve))
);

const input = {
  entityType: "appointment",
  entityId: "appt_1",
  nodeId: "send-reminder",
  condition: eligibleWhenActive(),
  eventName: "appointment.started",
};

describe("Workflow Entity Eligibility port", () => {
  it("returns only the eligible verdict for matching current state", async () => {
    const result = await Effect.runPromise(
      surface(() => ({ active: true })).evaluateEligibility(input)
    );

    expect(result).toEqual({ outcome: "eligible" });
  });

  it("distinguishes missing and ineligible current state", async () => {
    const missing = await Effect.runPromise(
      surface(() => null).evaluateEligibility(input)
    );
    const ineligible = await Effect.runPromise(
      surface(() => ({ active: false })).evaluateEligibility(input)
    );

    expect(missing).toMatchObject({
      outcome: "exit",
      reason: "entity_not_found",
    });
    expect(ineligible).toMatchObject({
      outcome: "exit",
      reason: "entity_condition_not_met",
    });
  });

  effectIt.effect("times out a resolver as an operational failure", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.exit(
          surface(
            () => new Promise<{ active: boolean } | null>(() => undefined)
          ).evaluateEligibility(input)
        )
      );
      yield* settle;
      yield* TestClock.adjust("10 seconds");

      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(
          Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        ).toEqual({
          kind: "failure",
          message: 'Failed to resolve Entity "appointment" for Eligibility',
        });
      }
    })
  );

  it("keeps resolver and state-schema defects in the failure channel", async () => {
    const resolverFailure = await Effect.runPromiseExit(
      surface(() =>
        Promise.reject(
          new Error("host unavailable for appt_secret with state active=true")
        )
      ).evaluateEligibility(input)
    );
    const invalidState = await Effect.runPromiseExit(
      surface(
        // @ts-expect-error Runtime validation covers JavaScript and unsafe callers.
        () => ({ active: "yes" })
      ).evaluateEligibility(input)
    );

    expect(Exit.isFailure(resolverFailure)).toBe(true);
    if (Exit.isFailure(resolverFailure)) {
      const failure = Option.getOrUndefined(
        Cause.findErrorOption(resolverFailure.cause)
      );
      expect(failure).toEqual({
        kind: "failure",
        message: 'Failed to resolve Entity "appointment" for Eligibility',
      });
      expect(JSON.stringify(failure)).not.toContain("appt_secret");
      expect(JSON.stringify(failure)).not.toContain("active=true");
    }
    expect(Exit.isFailure(invalidState)).toBe(true);
    if (Exit.isFailure(invalidState)) {
      const failure = Option.getOrUndefined(
        Cause.findErrorOption(invalidState.cause)
      );
      expect(failure).toMatchObject({
        kind: "defect",
        message: expect.stringContaining(
          'Entity "appointment" returned current state its schema does not accept'
        ),
      });
      expect(JSON.stringify(failure)).not.toContain('"active":"yes"');
    }
  });

  // `is_not_set` on a field the State schema no longer declares compiles and
  // evaluates true against any state, so evaluating it would answer eligible.
  it("fails a stored rule the current State schema refuses without resolving", async () => {
    const resolve = vi.fn(() => ({ active: true }));
    const guardedOnRemovedField = JSON.stringify({
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

    const exit = await Effect.runPromiseExit(
      surface(resolve).evaluateEligibility({
        ...input,
        condition: guardedOnRemovedField,
      })
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toEqual({
        kind: "defect",
        message: expect.stringContaining(
          'reads "archivedAt", which Entity "appointment" does not declare'
        ),
      });
    }
  });

  it("resolves and evaluates a stored rule the current State schema accepts", async () => {
    const resolve = vi.fn(() => ({ active: true }));

    const result = await Effect.runPromise(
      surface(resolve).evaluateEligibility(input)
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ outcome: "eligible" });
  });
});
