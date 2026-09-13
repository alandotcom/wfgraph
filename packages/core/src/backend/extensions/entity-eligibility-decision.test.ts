import { it as effectIt } from "@effect/vitest";
import { describe, expect, it, vi } from "vitest";
import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { defineEntity } from "#src/backend/extensions/define-entity";
import { decideEntityEligibility } from "#src/backend/extensions/entity-eligibility-decision";

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

type ResolveAppointment = (input: {
  entityId: string;
}) => { active: boolean } | null | Promise<{ active: boolean } | null>;

function fixtureEntity(resolve: ResolveAppointment) {
  return defineEntity({
    type: "appointment",
    label: "Appointment",
    state: Schema.Struct({ active: Schema.Boolean }),
    resolve,
  });
}

const settle = Effect.promise(
  () => new Promise<void>((resolve) => setImmediate(resolve))
);

/** Runs `decideEntityEligibility` against one fixture Entity, defaulted to an eligible-when-active rule and a fixed Arriving Event. */
function decide(
  resolve: ResolveAppointment,
  overrides?: { condition?: string; eventName?: string | null }
) {
  return decideEntityEligibility({
    definition: fixtureEntity(resolve),
    entityId: "appt_1",
    condition: overrides?.condition ?? eligibleWhenActive(),
    eventName: overrides?.eventName ?? "appointment.started",
    timeoutMs: 10_000,
  });
}

describe("decideEntityEligibility", () => {
  it("returns only the eligible verdict for matching current state", async () => {
    const result = await Effect.runPromise(decide(() => ({ active: true })));

    expect(result).toEqual({ outcome: "eligible" });
  });

  it("distinguishes missing and ineligible current state", async () => {
    const missing = await Effect.runPromise(decide(() => null));
    const ineligible = await Effect.runPromise(
      decide(() => ({ active: false }))
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
          decide(() => new Promise<{ active: boolean } | null>(() => undefined))
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
          _tag: "resolver_failed",
          message: 'Failed to resolve Entity "appointment" for Eligibility',
        });
      }
    })
  );

  it("keeps host error text and rejected State out of every cause", async () => {
    const resolverFailure = await Effect.runPromiseExit(
      decide(() =>
        Promise.reject(
          new Error("host unavailable for appt_secret with state active=true")
        )
      )
    );
    const invalidState = await Effect.runPromiseExit(
      decide(
        // @ts-expect-error Runtime validation covers JavaScript and unsafe callers.
        () => ({ active: "yes" })
      )
    );

    expect(Exit.isFailure(resolverFailure)).toBe(true);
    if (Exit.isFailure(resolverFailure)) {
      const cause = Option.getOrUndefined(
        Cause.findErrorOption(resolverFailure.cause)
      );
      expect(cause).toEqual({
        _tag: "resolver_failed",
        message: 'Failed to resolve Entity "appointment" for Eligibility',
      });
      expect(JSON.stringify(cause)).not.toContain("appt_secret");
      expect(JSON.stringify(cause)).not.toContain("active=true");
    }
    expect(Exit.isFailure(invalidState)).toBe(true);
    if (Exit.isFailure(invalidState)) {
      const cause = Option.getOrUndefined(
        Cause.findErrorOption(invalidState.cause)
      );
      expect(cause).toMatchObject({
        _tag: "rejected",
        message: expect.stringContaining(
          'Entity "appointment" returned current state its schema does not accept'
        ),
      });
      expect(JSON.stringify(cause)).not.toContain('"active":"yes"');
    }
  });

  // `is_not_set` on a field the State schema no longer declares compiles and
  // evaluates true against any state, so evaluating it would answer eligible.
  it("refuses a stored rule the current State schema rejects without resolving", async () => {
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
      decide(resolve, { condition: guardedOnRemovedField })
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toEqual({
        _tag: "rejected",
        message: expect.stringContaining(
          'reads "archivedAt", which Entity "appointment" does not declare'
        ),
      });
    }
  });

  it("resolves once and evaluates a rule the schema accepts", async () => {
    const resolve = vi.fn(() => ({ active: true }));

    const result = await Effect.runPromise(decide(resolve));

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ outcome: "eligible" });
  });

  // An Entity Eligibility condition can only read Entity State: `unreadableEligibilityRule`
  // (packages/shared/src/lifecycle/entity-eligibility.ts) refuses any stored rule that reads
  // the Arriving Event, so a null Event name here can never reach a live "$event" comparison.
  // This case only proves the null threads through the CEL context that
  // `evaluateCompiledCondition` always builds, rather than breaking evaluation.
  it("hands a null Arriving Event to the condition context", async () => {
    const result = await Effect.runPromise(
      decide(() => ({ active: true }), { eventName: null })
    );

    expect(result).toEqual({ outcome: "eligible" });
  });
});
