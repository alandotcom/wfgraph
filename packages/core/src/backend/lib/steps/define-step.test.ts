import { Effect, Schema, SchemaTransformation } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineStep, StepFailure } from "#src/backend/lib/steps/define-step";

// The two things the constructor does that reach outside the effect: the run
// log and the credential fetch. Both are the database in production, so both
// are the seam a test for this file replaces.
const mocks = vi.hoisted(() => ({
  fetchCredentials: vi.fn(),
  logStepStartDb: vi.fn(),
  logStepCompleteDb: vi.fn(),
}));

vi.mock("#src/backend/lib/credential-fetcher", () => ({
  fetchCredentials: mocks.fetchCredentials,
}));

vi.mock("#src/backend/lib/workflow-logging", () => ({
  logStepStartDb: mocks.logStepStartDb,
  logStepCompleteDb: mocks.logStepCompleteDb,
  logWorkflowCompleteDb: vi.fn(),
}));

const input = Schema.Struct({
  to: Schema.String,
  note: Schema.optionalKey(Schema.String),
});

const output = Schema.Struct({
  id: Schema.String,
  sentTo: Schema.String,
});

const METADATA = {
  label: "Send",
  description: "Sends a thing",
  category: "Demo",
};

const CONTEXT = {
  executionId: "exec_1",
  nodeId: "n1",
  nodeName: "Send",
  nodeType: "action",
  runMode: "live",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchCredentials.mockResolvedValue({ API_KEY: "k" });
  mocks.logStepStartDb.mockResolvedValue({ logId: "log_1", startTime: 10 });
  mocks.logStepCompleteDb.mockResolvedValue(undefined);
});

describe("defineStep", () => {
  const step = defineStep({
    ...METADATA,
    input,
    output,
    configFields: [{ key: "to", label: "To", type: "template-input" }],
    handler: Effect.fn(function* (config, context) {
      const credentials = yield* context.credentials;
      // A second read to show the fetch is memoised, not repeated.
      yield* context.credentials;

      if (!credentials.API_KEY) {
        return yield* Effect.fail(
          new StepFailure({ message: "API_KEY is not configured." })
        );
      }

      return { id: `${credentials.API_KEY}-1`, sentTo: config.to };
    }),
  });

  // The id is the integration's to give, so this is the same binding
  // `assembleExtensions` makes when it reads the record key the step sits under.
  const run = step.implement("demo/send");

  it("answers the envelope the engine reads, carrying the handler's payload", async () => {
    const result = await run({
      to: "someone",
      integrationId: "int_1",
      _context: CONTEXT,
    });

    expect(result).toEqual({
      success: true,
      data: { id: "k-1", sentTo: "someone" },
    });
  });

  it("carries the metadata the editor draws the action with", () => {
    expect(step.label).toBe("Send");
    expect(step.description).toBe("Sends a thing");
    expect(step.category).toBe("Demo");
    expect(step.configFields).toEqual([
      { key: "to", label: "To", type: "template-input" },
    ]);
  });

  it("fetches the integration's credentials once, however often they are read", async () => {
    await run({ to: "someone", integrationId: "int_1", _context: CONTEXT });

    expect(mocks.fetchCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.fetchCredentials).toHaveBeenCalledWith("int_1");
  });

  it("fetches nothing for a step no integration was configured for", async () => {
    const result = await run({ to: "someone", _context: CONTEXT });

    expect(mocks.fetchCredentials).toHaveBeenCalledTimes(0);
    expect(result).toEqual({
      success: false,
      error: { message: "API_KEY is not configured." },
    });
  });

  it("never asks for credentials a handler does not read", async () => {
    const quiet = defineStep({
      ...METADATA,
      input,
      output,
      configFields: [],
      handler: Effect.fn(function* (config) {
        return yield* Effect.succeed({ id: "fixed", sentTo: config.to });
      }),
    });

    await quiet.implement("demo/quiet")({
      to: "someone",
      integrationId: "int_1",
      _context: CONTEXT,
    });

    expect(mocks.fetchCredentials).toHaveBeenCalledTimes(0);
  });

  // The config a step receives is data: it came out of a jsonb column and
  // through template resolution, and neither of those is checked. A field that
  // is not what the schema describes is a step failure naming the field, not a
  // value the handler goes on to use.
  it("refuses a config the input schema does not describe", async () => {
    const result = await run({
      to: 7,
      integrationId: "int_1",
      _context: CONTEXT,
    });

    expect(result).toEqual({
      success: false,
      error: {
        message:
          'Invalid configuration for "demo/send": to: Expected string, got 7',
      },
    });
  });

  // The message a failed decode carries is written into the run log and handed
  // back over HTTP, so it names the field and stops short of quoting whatever
  // arrived in it.
  it("keeps a rejected value out of the message it writes down", async () => {
    const result = await run({
      to: "x".repeat(200),
      note: 5,
      integrationId: "int_1",
      _context: CONTEXT,
    });

    expect(result).toEqual({
      success: false,
      error: {
        message:
          'Invalid configuration for "demo/send": note: Expected string, got 5',
      },
    });
  });

  it("logs the input as it arrived, without the fields the engine added", async () => {
    await run({
      to: "someone",
      unread: "kept",
      actionType: "demo/send",
      integrationId: "int_1",
      _context: CONTEXT,
    });

    expect(mocks.logStepStartDb).toHaveBeenCalledWith({
      executionId: "exec_1",
      nodeId: "n1",
      nodeName: "Send",
      nodeType: "action",
      input: { to: "someone", unread: "kept" },
    });
  });

  it("logs a success with its payload and a failure with its reason", async () => {
    await run({ to: "someone", integrationId: "int_1", _context: CONTEXT });

    expect(mocks.logStepCompleteDb).toHaveBeenCalledWith({
      logId: "log_1",
      startTime: 10,
      status: "success",
      output: { id: "k-1", sentTo: "someone" },
      error: undefined,
    });

    vi.clearAllMocks();
    mocks.logStepStartDb.mockResolvedValue({ logId: "log_2", startTime: 20 });

    await run({ to: "someone", _context: CONTEXT });

    expect(mocks.logStepCompleteDb).toHaveBeenCalledWith({
      logId: "log_2",
      startTime: 20,
      status: "error",
      output: { message: "API_KEY is not configured." },
      error: "API_KEY is not configured.",
    });
  });

  it("tells the handler which mode the run is in, defaulting to live", async () => {
    const modes: string[] = [];
    const reporting = defineStep({
      ...METADATA,
      input,
      output,
      configFields: [],
      handler: Effect.fn(function* (config, context) {
        modes.push(context.runMode);
        return yield* Effect.succeed({ id: "x", sentTo: config.to });
      }),
    }).implement("demo/mode");

    // The three ways a mode reaches a handler: named, named as an empty key,
    // and absent along with the rest of the context. Only the last two default.
    await reporting({ to: "a", _context: { ...CONTEXT, runMode: "test" } });
    await reporting({ to: "a", _context: { ...CONTEXT, runMode: undefined } });
    await reporting({ to: "a" });

    expect(modes).toEqual(["test", "live", "live"]);
  });

  // A key present holding `undefined` is what a caller building the context
  // from optional values sends, and the context schema accepts it. It used to
  // fail the decode, which threw the whole context away: the run stopped
  // logging, and a test run read as a live one.
  it("keeps the run context when a field arrives as an empty key", async () => {
    await run({
      to: "someone",
      integrationId: "int_1",
      _context: { ...CONTEXT, runMode: undefined },
    });

    expect(mocks.logStepStartDb).toHaveBeenCalledWith({
      executionId: "exec_1",
      nodeId: "n1",
      nodeName: "Send",
      nodeType: "action",
      input: { to: "someone" },
    });
  });
});

/**
 * Both sides of a step boundary are JSON, and what runs there is the schema's
 * canonical JSON codec rather than the schema itself. These are the three things
 * that buys, and the third is the one worth having a test for: a `Date` reaching
 * the memoized result would come back a string on replay.
 */
describe("defineStep and the JSON codec", () => {
  const commaSeparated = Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transform<readonly string[], string>({
        decode: (value) => value.split(","),
        encode: (entries) => entries.join(","),
      })
    )
  );

  const timestamps = Schema.Struct({
    at: Schema.String.pipe(
      Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString)
    ),
  });

  it("hands the handler the decoded value a transform describes", async () => {
    let received: readonly string[] = [];

    const step = defineStep({
      ...METADATA,
      input: Schema.Struct({ urls: commaSeparated }),
      output: Schema.Struct({ count: Schema.Finite }),
      configFields: [{ key: "urls", label: "URLs", type: "text" }],
      handler: Effect.fn(function* (config) {
        received = config.urls;
        return yield* Effect.succeed({ count: config.urls.length });
      }),
    });

    const result = await step.implement("demo/urls")({ urls: "a,b,c" });

    expect(received).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ success: true, data: { count: 3 } });
  });

  it("encodes what the handler answered, so a Date leaves as a string", async () => {
    const step = defineStep({
      ...METADATA,
      input: Schema.Struct({}),
      output: timestamps,
      configFields: [],
      handler: Effect.fn(function* () {
        return yield* Effect.succeed({ at: new Date("2026-03-01T10:00:00Z") });
      }),
    });

    const result = await step.implement("demo/clock")({});

    expect(result).toEqual({
      success: true,
      data: { at: "2026-03-01T10:00:00.000Z" },
    });
  });

  // Reachable only through an `as`, an `any`, or a widened vendor type, because a
  // handler's return type is the decoded type. It fails the node once rather than
  // retrying, since the same value comes back on every attempt.
  it("fails the step when the handler answers with something unencodable", async () => {
    const step = defineStep({
      ...METADATA,
      input: Schema.Struct({}),
      output: timestamps,
      configFields: [],
      handler: Effect.fn(function* () {
        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the lie this case is about
        return yield* Effect.succeed({ at: "not a date" } as unknown as {
          at: Date;
        });
      }),
    });

    const result = await step.implement("demo/clock")({});

    expect(result).toEqual({
      success: false,
      error: {
        message:
          'Step "demo/clock" returned a value its output schema cannot encode: at: Expected a valid value, got "not a date"',
      },
    });
  });
});

/**
 * What an optional config field accepts, which the codec decides and the engine
 * has to agree with.
 *
 * `toCodecJson` rewrites `optional(X)` to `optionalKey(NullOr(X))`, so a key that
 * is absent or holds null is a field left blank and a key present holding
 * `undefined` is refused. The engine writes neither of the first two by accident:
 * `processTemplates` drops an undefined-valued key, which is what keeps a blank
 * field from failing the decode of every run.
 */
describe("defineStep and an optional config field", () => {
  const optionalInput = Schema.Struct({
    to: Schema.String,
    note: Schema.optional(Schema.String),
  });

  function runWith(config: Record<string, unknown>) {
    return defineStep({
      ...METADATA,
      input: optionalInput,
      output: Schema.Struct({ note: Schema.String }),
      configFields: [],
      handler: Effect.fn(function* (decoded) {
        return yield* Effect.succeed({ note: decoded.note ?? "blank" });
      }),
    }).implement("demo/optional")(config);
  }

  it("takes an absent key as a field left blank", async () => {
    expect(await runWith({ to: "someone" })).toEqual({
      success: true,
      data: { note: "blank" },
    });
  });

  it("takes a null as a field left blank", async () => {
    expect(await runWith({ to: "someone", note: null })).toEqual({
      success: true,
      data: { note: "blank" },
    });
  });

  // Nothing in the engine produces this, and the case is here so that the day
  // something does, the reason it fails is written down rather than discovered.
  it("refuses a key that is present and holds undefined", async () => {
    expect(await runWith({ to: "someone", note: undefined })).toEqual({
      success: false,
      error: {
        message:
          'Invalid configuration for "demo/optional": note: Expected string | null, got undefined',
      },
    });
  });
});

/**
 * What the output encode does to the payload, beyond turning a `Date` into a
 * string. Both of these are visible to a downstream node, so both are written
 * down.
 */
describe("defineStep and the shape of what it answers", () => {
  it("drops a key the output schema does not declare", async () => {
    const step = defineStep({
      ...METADATA,
      input: Schema.Struct({}),
      output: Schema.Struct({
        id: Schema.String.annotate({ description: "The id" }),
      }),
      configFields: [],
      handler: Effect.fn(function* () {
        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- a vendor object handed back whole, which is what this case is about
        return yield* Effect.succeed({ id: "1", vendorExtra: "dropped" } as {
          id: string;
        });
      }),
    });

    expect(await step.implement("demo/vendor")({})).toEqual({
      success: true,
      data: { id: "1" },
    });
  });

  it("answers an optional field the handler left empty as null", async () => {
    const step = defineStep({
      ...METADATA,
      input: Schema.Struct({}),
      output: Schema.Struct({
        id: Schema.String.annotate({ description: "The id" }),
        from: Schema.optional(
          Schema.String.annotate({ description: "Who sent it" })
        ),
      }),
      configFields: [],
      handler: Effect.fn(function* () {
        return yield* Effect.succeed({ id: "1", from: undefined });
      }),
    });

    expect(await step.implement("demo/optional-out")({})).toEqual({
      success: true,
      data: { id: "1", from: null },
    });
  });
});

/**
 * The `load` arm, which is how an integration keeps a handler's module -- and the
 * vendor SDK inside it -- out of a process that never runs the action.
 */
describe("defineStep and a loaded handler", () => {
  function stepThatLoads(load: () => Promise<never>) {
    return defineStep({
      ...METADATA,
      input: Schema.Struct({ to: Schema.String }),
      output: Schema.Struct({
        id: Schema.String.annotate({ description: "The id" }),
      }),
      configFields: [{ key: "to", label: "To", type: "text", required: true }],
      load,
    }).implement("demo/loaded");
  }

  it("does not load the module until the step runs", () => {
    const load = vi.fn();

    stepThatLoads(load as never);

    expect(load).not.toHaveBeenCalled();
  });

  it("loads it once, however many times the step runs", async () => {
    const load = vi.fn(() =>
      Promise.resolve(
        Effect.fn(function* (config: { to: string }) {
          return yield* Effect.succeed({ id: config.to });
        })
      )
    );

    const run = stepThatLoads(load as never);
    expect(await run({ to: "a" })).toEqual({
      success: true,
      data: { id: "a" },
    });
    expect(await run({ to: "b" })).toEqual({
      success: true,
      data: { id: "b" },
    });

    expect(load).toHaveBeenCalledTimes(1);
  });

  // A module that fails to import is a deployment problem rather than a step
  // failure, so it leaves by the throw path, where the function-level retry picks it
  // up. What this pins is that the retry has something to retry: a rejection is
  // forgotten rather than remembered, so the next attempt imports again.
  it("leaves a failed import as a defect, and tries again on the next run", async () => {
    const handler = Effect.fn(function* () {
      return yield* Effect.succeed({ id: "loaded" });
    });
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("chunk missing"))
      .mockResolvedValueOnce(handler);

    const run = stepThatLoads(load as never);

    await expect(run({ to: "a" })).rejects.toThrow("chunk missing");
    expect(await run({ to: "a" })).toEqual({
      success: true,
      data: { id: "loaded" },
    });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
