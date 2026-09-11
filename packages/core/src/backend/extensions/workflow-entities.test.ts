import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vitest";
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
  }) => { active: boolean } | null | Promise<{ active: boolean } | null>,
  options?: { entityResolverTimeoutMs?: number }
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
  return createWorkflowEntities(
    assembleExtensions({ events: [event] }, options)
  );
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
  it("fails a run whose Entity type the surface no longer declares", async () => {
    const exit = await Effect.runPromiseExit(
      surface(() => ({ active: true })).evaluateEligibility({
        ...input,
        entityType: "missing",
      })
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toEqual({
        kind: "defect",
        message: 'Entity "missing" is unavailable for this workflow run',
      });
    }
  });

  it("maps a resolver failure to a retryable failure and every other cause to a defect", async () => {
    const resolverFailure = await Effect.runPromiseExit(
      surface(() =>
        Promise.reject(new Error("host unavailable"))
      ).evaluateEligibility(input)
    );
    const schemaRefused = await Effect.runPromiseExit(
      surface(() => ({ active: true })).evaluateEligibility({
        ...input,
        condition: JSON.stringify({
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
        }),
      })
    );

    expect(Exit.isFailure(resolverFailure)).toBe(true);
    if (Exit.isFailure(resolverFailure)) {
      expect(
        Option.getOrUndefined(Cause.findErrorOption(resolverFailure.cause))
      ).toEqual({
        kind: "failure",
        message: 'Failed to resolve Entity "appointment" for Eligibility',
      });
    }
    expect(Exit.isFailure(schemaRefused)).toBe(true);
    if (Exit.isFailure(schemaRefused)) {
      expect(
        Option.getOrUndefined(Cause.findErrorOption(schemaRefused.cause))
      ).toMatchObject({
        kind: "defect",
        message: expect.stringContaining(
          'reads "archivedAt", which Entity "appointment" does not declare'
        ),
      });
    }
  });

  effectIt.effect(
    "passes the surface's resolver deadline to the decision",
    () =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.exit(
            surface(
              () => new Promise<{ active: boolean } | null>(() => undefined),
              { entityResolverTimeoutMs: 50 }
            ).evaluateEligibility(input)
          )
        );
        yield* settle;
        yield* TestClock.adjust("50 millis");

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
});
