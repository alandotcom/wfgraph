import { Effect, Schema, SchemaTransformation } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStep } from "#src/backend/extensions/steps/define-step";
import {
  CONTEXT,
  METADATA,
  credentialsFor,
  runStep,
  runner,
} from "#src/backend/extensions/steps/define-step-test-utils";

beforeEach(() => {
  credentialsFor.mockClear();
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
      handler: Effect.fn(function* (bag) {
        received = bag.input.urls;
        return yield* Effect.succeed({ count: bag.input.urls.length });
      }),
    });

    const result = await runStep(step.implement("demo/urls")(runner))({
      urls: "a,b,c",
      _context: CONTEXT,
    });

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

    const result = await runStep(step.implement("demo/clock")(runner))({
      _context: CONTEXT,
    });

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

    const result = await runStep(step.implement("demo/clock")(runner))({
      _context: CONTEXT,
    });

    expect(result).toEqual({
      success: false,
      error: {
        message:
          'Step "demo/clock" returned a value its output schema cannot encode: at: Expected a valid value',
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
    const step = defineStep({
      ...METADATA,
      input: optionalInput,
      output: Schema.Struct({ note: Schema.String }),
      configFields: [],
      handler: Effect.fn(function* (bag) {
        return yield* Effect.succeed({ note: bag.input.note ?? "blank" });
      }),
    }).implement("demo/optional")(runner);
    return runStep(step)({ ...config, _context: CONTEXT });
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
          'Step "demo/optional" received an invalid configuration: note: Expected string | null',
      },
    });
  });
});

/**
 * A step whose schemas came from somewhere other than Effect.
 *
 * Zod stands in for any Standard Schema library. What it publishes is a
 * validator and a JSON Schema, so the form derives, the config is checked, and
 * the handler's answer runs through the same validate on the way out. The
 * encode the Effect arm runs has no counterpart here; the returned `value` is
 * what the node keeps. The handler is still an Effect here; the suite below
 * writes one without.
 */
describe("defineStep and a schema from another library", () => {
  const step = defineStep({
    ...METADATA,
    input: z.object({
      to: z.string().describe("Recipient"),
      note: z.string().optional(),
    }),
    output: z.object({ id: z.string().describe("Id") }),
    handler: (bag) => Effect.succeed({ id: `sent-${bag.input.to}` }),
  });

  const run = runStep(step.implement("demo/foreign")(runner));

  it("derives the form from the schema it was given", () => {
    expect(step.configFields).toEqual([
      { key: "to", label: "Recipient", type: "template-input", required: true },
      { key: "note", label: "Note", type: "template-input" },
    ]);
  });

  it("runs the handler on a config the schema accepts", async () => {
    expect(await run({ to: "someone", _context: CONTEXT })).toEqual({
      success: true,
      data: { id: "sent-someone" },
    });
  });

  // The message names the path and stops there. A foreign library words its own
  // issues and may quote what arrived in them, and this string is written to the
  // run log and answered over HTTP.
  it("refuses a config the schema does not describe, naming the path", async () => {
    expect(await run({ to: 7, _context: CONTEXT })).toEqual({
      success: false,
      error: {
        message: 'Step "demo/foreign" received an invalid configuration: to',
      },
    });
  });

  // Zod's default object strips undeclared keys in `~standard.validate`, so the
  // oversized vendor object the handler answered with does not reach the envelope.
  it("keeps only the keys the output schema's validate returns", async () => {
    const leaky = defineStep({
      ...METADATA,
      input: z.object({ to: z.string() }),
      output: z.object({ id: z.string() }),
      handler: () =>
        Effect.succeed({
          id: "public-123",
          apiToken: "should-not-leak",
          rawVendorResponse: { nested: true },
        }),
    });

    expect(
      await runStep(leaky.implement("demo/trim")(runner))({
        to: "someone",
        _context: CONTEXT,
      })
    ).toEqual({
      success: true,
      data: { id: "public-123" },
    });
  });

  // A handler answering outside its output schema fails the node once, the same
  // way the Effect encode arm does for a value it cannot encode.
  it("fails the node when the answer does not satisfy the output schema", async () => {
    const bad = defineStep({
      ...METADATA,
      input: z.object({ to: z.string() }),
      output: z.object({ id: z.string() }),
      // The return type is the decoded side; reaching a wrong shape takes a cast.
      handler: () => Effect.succeed({ id: 7 } as unknown as { id: string }),
    });

    expect(
      await runStep(bad.implement("demo/bad-output")(runner))({
        to: "someone",
        _context: CONTEXT,
      })
    ).toEqual({
      success: false,
      error: {
        message:
          'Step "demo/bad-output" returned a value its output schema does not accept: id',
      },
    });
  });

  // `z.looseObject` is how an author says undeclared keys should survive. The
  // validate still runs; it just keeps what the schema's policy keeps.
  it("keeps undeclared keys when the output schema says so", async () => {
    const open = defineStep({
      ...METADATA,
      input: z.object({ to: z.string() }),
      output: z.looseObject({ id: z.string() }),
      handler: () =>
        Effect.succeed({
          id: "public-123",
          extra: "kept",
        }),
    });

    expect(
      await runStep(open.implement("demo/passthrough")(runner))({
        to: "someone",
        _context: CONTEXT,
      })
    ).toEqual({
      success: true,
      data: { id: "public-123", extra: "kept" },
    });
  });
});

/**
 * A step whose input schema is genuinely open, which is the one shape the three
 * keys the engine's dispatch owns could reach a handler through.
 *
 * A closed schema drops them on its own. `StructWithRest` keeps whatever it is
 * handed, so the strip has to happen before the decode rather than rely on the
 * schema to do it. `defineAction` reads through the same reader.
 */
describe("defineStep and an input schema that declares a rest", () => {
  it("keeps the engine's own keys out of the config", async () => {
    let received: Record<string, unknown> = {};

    const open = defineStep({
      ...METADATA,
      input: Schema.StructWithRest(Schema.Struct({}), [
        Schema.Record(Schema.String, Schema.Unknown),
      ]),
      output: Schema.Struct({ id: Schema.String }),
      configFields: [],
      handler: Effect.fn(function* (bag) {
        received = bag.input;
        return yield* Effect.succeed({ id: "1" });
      }),
    });

    await runStep(open.implement("demo/open")(runner))({
      to: "someone",
      actionType: "demo",
      integrationId: "int_1",
      _context: CONTEXT,
    });

    expect(received).toEqual({ to: "someone" });
  });
});
