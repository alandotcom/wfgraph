import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CredentialsUnavailable } from "#src/backend/extensions/credential-fetcher";
import { stubStepEnvironment } from "#src/backend/lib/effect/test-layers";
import {
  defineStep,
  type NodeStepApi,
  StepFailure,
} from "#src/backend/extensions/steps/define-step";
import {
  CONTEXT,
  METADATA,
  credentialsFor,
  input,
  output,
  runStep,
  runner,
} from "#src/backend/extensions/steps/define-step-test-utils";

beforeEach(() => {
  credentialsFor.mockClear();
});

/**
 * The two kinds of failure a step tells apart, which decide whether the node is
 * retried.
 *
 * A `StepFailure` is the step's own answer: the config was wrong, or the vendor
 * said no, and either comes back the same on a second attempt, so it becomes the
 * envelope and fails the node once. A `CredentialsUnavailable` is the store
 * refusing the read, which is nothing about the run, so it stays in the error
 * channel and rejects -- the engine's durable runtime reads a rejected step as
 * one to run again.
 */
describe("defineStep and a credential store that refuses the read", () => {
  const unreadable = () =>
    Effect.fail(
      new CredentialsUnavailable({
        integrationId: "int_1",
        message: 'Could not read the credentials for integration "int_1".',
      })
    );

  const step = defineStep({
    ...METADATA,
    input,
    output,
    configFields: [],
    handler: Effect.fn(function* (bag) {
      const credentials = yield* bag.credentials;
      return yield* Effect.succeed({
        id: `${credentials.API_KEY}`,
        sentTo: bag.input.to,
      });
    }),
  });

  it("rejects rather than answering the envelope, so the step is retried", async () => {
    const run = runStep(
      step.implement("demo/send")(
        stubStepEnvironment({ credentialsFor: unreadable })
      )
    );

    await expect(
      run({ to: "someone", integrationId: "int_1", _context: CONTEXT })
    ).rejects.toMatchObject({
      _tag: "CredentialsUnavailable",
      message: 'Could not read the credentials for integration "int_1".',
    });
  });

  it("costs nothing to a step whose handler never asks for credentials", async () => {
    const quiet = defineStep({
      ...METADATA,
      input,
      output,
      configFields: [],
      handler: Effect.fn(function* (bag) {
        return yield* Effect.succeed({ id: "fixed", sentTo: bag.input.to });
      }),
    });

    const result = await runStep(
      quiet.implement("demo/quiet")(
        stubStepEnvironment({ credentialsFor: unreadable })
      )
    )({ to: "someone", integrationId: "int_1", _context: CONTEXT });

    expect(result).toEqual({
      success: true,
      data: { id: "fixed", sentTo: "someone" },
    });
  });

  // The contrast that makes the case above mean something: everything a step can
  // answer for is still the one envelope, and the node fails on it once.
  it("keeps a handler's own failure in the envelope", async () => {
    const refusing = defineStep({
      ...METADATA,
      input,
      output,
      configFields: [],
      handler: Effect.fn(function* () {
        return yield* new StepFailure({ message: "The vendor said no." });
      }),
    });

    const result = await runStep(refusing.implement("demo/refused")(runner))({
      to: "someone",
      _context: CONTEXT,
    });

    expect(result).toEqual({
      success: false,
      error: { message: "The vendor said no." },
    });
  });

  // The same rule through the Promise arm, which is the one place a plain
  // `catch (error)` around the fetch would get it wrong: a rejection carrying a
  // refused read is not the handler's failure to report.
  it("rejects for an async handler that let the refusal through", async () => {
    const asyncStep = defineStep({
      ...METADATA,
      input,
      output,
      configFields: [],
      handler: async (bag) => {
        const credentials = await bag.readCredentials();
        return { id: `${credentials.API_KEY}`, sentTo: bag.input.to };
      },
    });

    const run = runStep(
      asyncStep.implement("demo/async")(
        stubStepEnvironment({ credentialsFor: unreadable })
      )
    );

    await expect(
      run({ to: "someone", integrationId: "int_1", _context: CONTEXT })
    ).rejects.toMatchObject({
      _tag: "CredentialsUnavailable",
      message: 'Could not read the credentials for integration "int_1".',
    });
  });
});

/**
 * A step written the way a host's `defineAction` is written: Zod for the
 * schemas, an `async` handler, and no Effect anywhere in the definition.
 *
 * Integrations author with Effect (`@wfgraph/core/plugin`). The Promise arm stays
 * for host actions; both shapes share `HandlerAnswer` / `toHandlerEffect`.
 */
describe("defineStep and a handler that is not an Effect", () => {
  const asyncStep = defineStep({
    ...METADATA,
    input: z.object({ to: z.string().describe("Recipient") }),
    output: z.object({ id: z.string().describe("Id") }),
    handler: async (bag) => {
      const credentials = await bag.readCredentials();
      return { id: `${credentials.API_KEY}-${bag.input.to}` };
    },
  });

  const run = runStep(asyncStep.implement("demo/async")(runner));

  it("answers the envelope the engine reads", async () => {
    expect(
      await run({ to: "someone", integrationId: "int_1", _context: CONTEXT })
    ).toEqual({ success: true, data: { id: "k-someone" } });
  });

  it("reads the credentials once, however often the handler asks", async () => {
    const twice = defineStep({
      ...METADATA,
      input: z.object({ to: z.string() }),
      output: z.object({ id: z.string().describe("Id") }),
      handler: async (bag) => {
        await bag.readCredentials();
        const credentials = await bag.readCredentials();
        return { id: `${credentials.API_KEY}-${bag.input.to}` };
      },
    });

    await runStep(twice.implement("demo/twice")(runner))({
      to: "someone",
      integrationId: "int_1",
      _context: CONTEXT,
    });

    expect(credentialsFor).toHaveBeenCalledTimes(1);
  });

  // A throw is how this arm fails a node, the same way `defineAction`'s handler
  // does. The message is the run log's sentence.
  it("turns a throw into the node's one failure", async () => {
    const throwing = defineStep({
      ...METADATA,
      input: z.object({ to: z.string() }),
      output: z.object({ id: z.string().describe("Id") }),
      handler: async () => {
        await Promise.resolve();
        throw new Error("The system said no.");
      },
    });

    expect(
      await runStep(throwing.implement("demo/throwing")(runner))({
        to: "someone",
        _context: CONTEXT,
      })
    ).toEqual({ success: false, error: { message: "The system said no." } });
  });

  // A handler need not be async at all. This is the same path with nothing to
  // await, and it is what a step doing pure work writes.
  it("takes a plain value back from a handler that awaits nothing", async () => {
    const plain = defineStep({
      ...METADATA,
      input: z.object({ to: z.string() }),
      output: z.object({ id: z.string().describe("Id") }),
      handler: (bag) => ({ id: bag.input.to.toUpperCase() }),
    });

    expect(
      await runStep(plain.implement("demo/plain")(runner))({
        to: "someone",
        _context: CONTEXT,
      })
    ).toEqual({ success: true, data: { id: "SOMEONE" } });
  });

  // A throw before the first await escapes as a rejected call rather than a
  // returned Promise, so the wrap around the call is what catches it.
  it("turns a synchronous throw into the same failure", async () => {
    const throwing = defineStep({
      ...METADATA,
      input: z.object({ to: z.string() }),
      output: z.object({ id: z.string().describe("Id") }),
      handler: () => {
        throw new Error("Refused before it started.");
      },
    });

    expect(
      await runStep(throwing.implement("demo/sync-throw")(runner))({
        to: "someone",
        _context: CONTEXT,
      })
    ).toEqual({
      success: false,
      error: { message: "Refused before it started." },
    });
  });
});

/**
 * The memo's JSON rule, checked by the compiler rather than at run time.
 *
 * A value handed to `step.run` is stored as JSON and read back on the next
 * attempt, so a `Date` in it would arrive as a string with its type still
 * claiming otherwise. `JsonSafe` refuses that where it is written. Nothing here
 * runs; a missing error fails `pnpm run type-check` instead.
 */
describe("what step.run accepts", () => {
  it("takes a value that survives the round trip and refuses one that does not", () => {
    const check = (step: NodeStepApi) => {
      // Promise overload — host defineAction.
      void step.run("sdk", async () => ({ id: "1", labels: [{ name: "a" }] }));
      void step.run("iso", async () => ({ at: new Date().toISOString() }));
      // Effect overload — integration authoring path.
      void step.run(
        "effect-iso",
        Effect.succeed({ at: new Date().toISOString() })
      );

      // @ts-expect-error a Date is a string by the time a replay reads it
      void step.run("date", async () => ({ at: new Date() }));
      // @ts-expect-error a Map is `{}` by the time a replay reads it
      void step.run("map", async () => new Map<string, string>());
      // @ts-expect-error Effect arm refuses a Date the same way
      void step.run("effect-date", Effect.succeed({ at: new Date() }));
    };

    expect(check).toBeTypeOf("function");
  });
});

/**
 * The Promise `step.run` adapter memoizes the bare value. A throw leaves no
 * stored entry so a function-level retry re-runs the work (Inngest's model).
 */
describe("Promise step.run adapter", () => {
  it("memoizes a host-style Promise factory as the bare value", async () => {
    let calls = 0;
    const step = defineStep({
      ...METADATA,
      input: z.object({ to: z.string() }),
      output: z.object({ id: z.string() }),
      handler: ({ input: config, step: nodeStep }) =>
        nodeStep.run("create", async () => {
          calls += 1;
          return { id: `made-${config.to}` };
        }),
    });

    const remembered = new Map<string, unknown>();
    const steps = {
      run: async <T>(stepId: string, work: () => Promise<T>) => {
        if (remembered.has(stepId)) {
          return remembered.get(stepId) as T;
        }
        const value = await work();
        remembered.set(stepId, value);
        return value;
      },
    };

    const run = runStep(step.implement("demo/promise-run")(runner));
    const first = await run({ to: "someone", _context: CONTEXT }, steps);
    const second = await run({ to: "someone", _context: CONTEXT }, steps);

    expect(first).toEqual({ success: true, data: { id: "made-someone" } });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(remembered.get("create")).toEqual({ id: "made-someone" });
  });

  it("does not memoize a thrown Promise step", async () => {
    let calls = 0;
    const step = defineStep({
      ...METADATA,
      input: z.object({ to: z.string() }),
      output: z.object({ id: z.string() }),
      handler: ({ step: nodeStep }) =>
        nodeStep.run("create", async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("transient");
          }
          return { id: "recovered" };
        }),
    });

    const remembered = new Map<string, unknown>();
    const steps = {
      run: async <T>(stepId: string, work: () => Promise<T>) => {
        if (remembered.has(stepId)) {
          return remembered.get(stepId) as T;
        }
        const value = await work();
        remembered.set(stepId, value);
        return value;
      },
    };

    const run = runStep(step.implement("demo/promise-retry")(runner));
    const first = await run({ to: "someone", _context: CONTEXT }, steps);
    const second = await run({ to: "someone", _context: CONTEXT }, steps);

    expect(first).toEqual({
      success: false,
      error: { message: "transient" },
    });
    expect(second).toEqual({ success: true, data: { id: "recovered" } });
    expect(calls).toBe(2);
    expect(remembered.has("create")).toBe(true);
    expect(remembered.get("create")).toEqual({ id: "recovered" });
  });
});
