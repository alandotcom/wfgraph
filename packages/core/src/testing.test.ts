/**
 * What `runAction` and `runHostAction` cover, which is the whole boundary
 * rather than the handler: a case here is the shape every integration's own
 * suite, and a host's suite for its own actions, is written in.
 */

import { Effect, Schema, SchemaTransformation } from "effect";
import { describe, expect, it } from "vitest";
import { defineIntegration } from "#src/backend/extensions/define-integration";
import { StepFailure } from "#src/backend/extensions/steps/define-step";
import { z } from "zod";
import { defineAction } from "#src/index";
import {
  actionData,
  actionError,
  runAction,
  runHostAction,
} from "#src/testing";

/** Counts the reads, so a case can pin that a handler never asked. */
function credentialsRead(values: Record<string, string | undefined>) {
  const reads = { count: 0 };

  return {
    reads,
    credentials: Effect.sync(() => {
      reads.count += 1;
      return values;
    }),
  };
}

const demo = defineIntegration({
  type: "demo",
  label: "Demo",
  description: "Everything a case here needs to drive",
  credentials: { DEMO_API_KEY: { label: "API Key", type: "password" } },
  actions: {
    greet: {
      label: "Greet",
      description: "Answers a greeting, or says which credential is missing",
      input: Schema.Struct({
        name: Schema.String,
        skip: Schema.optionalKey(Schema.String),
      }),
      output: Schema.Struct({
        greeting: Schema.String.annotate({ description: "What it said" }),
      }),
      handler: Effect.fn(function* (bag) {
        // Returns before reading anything, which is what the lazy read is for.
        if (bag.input.skip === "yes") {
          return { greeting: "" };
        }

        const { DEMO_API_KEY } = yield* bag.credentials;
        if (!DEMO_API_KEY) {
          return yield* new StepFailure({
            message: "DEMO_API_KEY is not configured.",
          });
        }

        return { greeting: `hello ${bag.input.name} from ${DEMO_API_KEY}` };
      }),
    },
    stamp: {
      label: "Stamp",
      description: "Answers a Date, which the envelope cannot carry",
      input: Schema.Struct({ at: Schema.String }),
      output: Schema.Struct({
        at: Schema.String.pipe(
          Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString)
        ).annotate({ description: "When" }),
      }),
      handler: ({ input }) => ({ at: new Date(input.at) }),
    },
  },
});

describe("runAction", () => {
  it("decodes the config, runs the handler, and answers the envelope", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const answer = yield* runAction(demo, "greet", {
          input: { name: "Ada" },
          credentials: { DEMO_API_KEY: "key_1" },
        });

        expect(answer).toEqual({
          success: true,
          data: { greeting: "hello Ada from key_1" },
        });
      })
    ));

  // The engine memoizes a step result as JSON, so the encode is part of the
  // boundary rather than something a case runs for itself.
  it("answers the encoded payload, not what the handler returned", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const answer = actionData(
          yield* runAction(demo, "stamp", {
            input: { at: "2026-01-02T03:04:05.000Z" },
          })
        );

        expect(answer).toEqual({ at: "2026-01-02T03:04:05.000Z" });
      })
    ));

  it("fails the node with the sentence the handler gave up with", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const failure = actionError(
          yield* runAction(demo, "greet", {
            input: { name: "Ada" },
            credentials: {},
          })
        );

        expect(failure.message).toBe("DEMO_API_KEY is not configured.");
      })
    ));

  it("fails the node when the config does not fit the input schema", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const failure = actionError(
          yield* runAction(demo, "greet", { input: { name: 7 } })
        );

        expect(failure.message).toContain(
          'Step "demo/greet" received an invalid configuration'
        );
      })
    ));

  // The whole reason credentials reach a handler as an effect: a step that
  // decides it has nothing to do never reads the integration's secrets.
  it("leaves the credentials unread when the handler never asks", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { reads, credentials } = credentialsRead({
          DEMO_API_KEY: "key_1",
        });

        yield* runAction(demo, "greet", {
          input: { name: "Ada", skip: "yes" },
          credentials,
        });

        expect(reads.count).toBe(0);
      })
    ));

  it("reads them once for a handler that does ask", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { reads, credentials } = credentialsRead({
          DEMO_API_KEY: "key_1",
        });

        yield* runAction(demo, "greet", {
          input: { name: "Ada" },
          credentials,
        });

        expect(reads.count).toBe(1);
      })
    ));

  it("holds the slug to the actions the integration declared", () => {
    const misspelt = () =>
      // @ts-expect-error "greeet" is not an action of this integration
      runAction(demo, "greeet", { input: {} });

    expect(misspelt).toBeTypeOf("function");
  });
});

describe("actionData and actionError", () => {
  // Neither hides the other's outcome, which is what flipping an Effect used to
  // guarantee: a case expecting one and getting the other fails rather than
  // reading undefined off an envelope of the wrong shape.
  it("throws for a step that gave up, naming the reason", () => {
    expect(() =>
      actionData({ success: false, error: { message: "no key" } })
    ).toThrow("no key");
  });

  it("throws for a step that did its work", () => {
    expect(() => actionError({ success: true, data: { ok: true } })).toThrow(
      "Expected the action to give up"
    );
  });
});

/**
 * A host action the way an adopter writes one: Promise-first, with its side
 * effect inside `step.run`, and a test run that sends nothing.
 */
function cancelAction(cancelled: string[]) {
  return defineAction({
    id: "appointments/cancel",
    label: "Cancel Appointment",
    description: "Cancels an appointment",
    input: z.object({ appointmentId: z.string() }),
    output: z.object({ appointmentId: z.string(), status: z.string() }),
    handler: async ({ input, runMode, step }) => {
      if (runMode === "test") {
        return { appointmentId: input.appointmentId, status: "skipped" };
      }
      const status = await step.run("cancel", () => {
        cancelled.push(input.appointmentId);
        return Promise.resolve("cancelled");
      });
      if (input.appointmentId === "appt_locked") {
        throw new Error("The appointment is locked");
      }
      return { appointmentId: input.appointmentId, status };
    },
  });
}

describe("runHostAction", () => {
  it("answers the envelope and records each step the handler ran", async () => {
    const cancelled: string[] = [];
    const run = await runHostAction(cancelAction(cancelled), {
      input: { appointmentId: "appt_1" },
    });

    expect(actionData(run.result)).toEqual({
      appointmentId: "appt_1",
      status: "cancelled",
    });
    expect(run.steps).toEqual([
      { id: "cancel", replayed: false, ok: true, value: "cancelled" },
    ]);
    expect(cancelled).toEqual(["appt_1"]);
  });

  // The executor answers a step that ran on an earlier pass from its memo, so
  // a retry repeats no side effect; `replay` is that memo.
  it("answers a replayed step without running its work", async () => {
    const cancelled: string[] = [];
    const run = await runHostAction(cancelAction(cancelled), {
      input: { appointmentId: "appt_1" },
      replay: { cancel: "cancelled" },
    });

    expect(run.steps).toEqual([
      { id: "cancel", replayed: true, ok: true, value: "cancelled" },
    ]);
    expect(cancelled).toEqual([]);
  });

  it("passes the run mode and resolves with the failure a throw makes", async () => {
    const cancelled: string[] = [];
    const action = cancelAction(cancelled);

    const testRun = await runHostAction(action, {
      input: { appointmentId: "appt_1" },
      runMode: "test",
    });
    expect(actionData(testRun.result)).toMatchObject({ status: "skipped" });

    const locked = await runHostAction(action, {
      input: { appointmentId: "appt_locked" },
    });
    expect(actionError(locked.result).message).toContain(
      "The appointment is locked"
    );
  });
});
