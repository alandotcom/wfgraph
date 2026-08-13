import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  defineStep,
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

describe("defineStep", () => {
  const step = defineStep({
    ...METADATA,
    input,
    output,
    configFields: [{ key: "to", label: "To", type: "template-input" }],
    handler: Effect.fn(function* (bag) {
      const credentials = yield* bag.credentials;
      // A second read to show the fetch is memoised, not repeated.
      yield* bag.credentials;

      if (!credentials.API_KEY) {
        return yield* new StepFailure({
          message: "API_KEY is not configured.",
        });
      }

      return { id: `${credentials.API_KEY}-1`, sentTo: bag.input.to };
    }),
  });

  // The id is the integration's to give, so this is the same binding
  // `assembleExtensions` makes when it reads the record key the step sits under.
  const run = runStep(step.implement("demo/send")(runner));

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
  });

  // Every key comes from the schema. `to` is the one the author wrote a field
  // for and keeps their label; `note` was never written down and is drawn all
  // the same, which is what a step declaring no fields at all relies on.
  it("draws a field for every input key, the author's entry over the schema's", () => {
    expect(step.configFields).toEqual([
      { key: "to", label: "To", type: "template-input", required: true },
      { key: "note", label: "Note", type: "template-input" },
    ]);
  });

  it("fetches the integration's credentials once, however often they are read", async () => {
    await run({ to: "someone", integrationId: "int_1", _context: CONTEXT });

    expect(credentialsFor).toHaveBeenCalledTimes(1);
    expect(credentialsFor).toHaveBeenCalledWith("int_1");
  });

  it("fetches nothing for a step no integration was configured for", async () => {
    const result = await run({ to: "someone", _context: CONTEXT });

    expect(credentialsFor).toHaveBeenCalledTimes(0);
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
      handler: Effect.fn(function* (bag) {
        return yield* Effect.succeed({ id: "fixed", sentTo: bag.input.to });
      }),
    });

    await runStep(quiet.implement("demo/quiet")(runner))({
      to: "someone",
      integrationId: "int_1",
      _context: CONTEXT,
    });

    expect(credentialsFor).toHaveBeenCalledTimes(0);
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
          'Step "demo/send" received an invalid configuration: to: Expected string',
      },
    });
  });

  // The message a failed decode carries is written into the run log and handed
  // back over HTTP, so it names the field and holds nothing of what arrived in
  // it. The 200-character `to` is the value that would show up if it did.
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
          'Step "demo/send" received an invalid configuration: note: Expected string',
      },
    });
  });

  /** A step that records the run mode each call reached its handler with. */
  function makeReportingStep(actionId: string) {
    const modes: string[] = [];
    const reporting = runStep(
      defineStep({
        ...METADATA,
        input,
        output,
        configFields: [],
        handler: Effect.fn(function* (bag) {
          modes.push(bag.runMode);
          return yield* Effect.succeed({ id: "x", sentTo: bag.input.to });
        }),
      }).implement(actionId)(runner)
    );

    return { reporting, modes };
  }

  it("tells the handler which mode the run is in, defaulting to live", async () => {
    const { reporting, modes } = makeReportingStep("demo/mode");

    // The two ways a mode reaches a handler: named, and named as an empty key.
    // Only the second defaults.
    await reporting({ to: "a", _context: { ...CONTEXT, runMode: "test" } });
    await reporting({ to: "a", _context: { ...CONTEXT, runMode: undefined } });

    expect(modes).toEqual(["test", "live"]);
  });

  // An input with no context is a Workflow Graph bug rather than something an author
  // wrote, and running anyway would hand a handler the node ids it was promised
  // as undefined. `defineAction` answers the same way.
  it("fails the node rather than calling the handler without a context", async () => {
    const { reporting, modes } = makeReportingStep("demo/no-context");

    expect(await reporting({ to: "a" })).toEqual({
      success: false,
      error: {
        message:
          'Step "demo/no-context" was called without a step context, so the node it belongs to cannot be identified.',
      },
    });
    expect(modes).toEqual([]);
  });

  // A key present holding `undefined` is what a caller building the context
  // from optional values sends, and the context schema accepts it. Failing the
  // decode there would throw the whole context away: the run would stop
  // logging, and a test run would read as a live one.
  it("keeps the run context when a field arrives as an empty key", async () => {
    const { reporting, modes } = makeReportingStep("demo/empty-key");

    await reporting({
      to: "someone",
      integrationId: "int_1",
      _context: { ...CONTEXT, runMode: undefined },
    });

    expect(modes).toEqual(["live"]);
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

    expect(
      await runStep(step.implement("demo/vendor")(runner))({
        _context: CONTEXT,
      })
    ).toEqual({
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

    expect(
      await runStep(step.implement("demo/optional-out")(runner))({
        _context: CONTEXT,
      })
    ).toEqual({
      success: true,
      data: { id: "1", from: null },
    });
  });
});

/**
 * What the schema says and what the author adds, in one list.
 *
 * Assembly used to refuse a step whose required key had no field behind it,
 * because a builder could then save a node whose config decode failed on every
 * run. Deriving the field removes the case rather than catching it, so these
 * cases stand where that check stood.
 */
describe("defineStep and the config form", () => {
  const anOutput = Schema.Struct({
    id: Schema.String.annotate({ description: "Id" }),
  });

  const noop = Effect.fn(function* () {
    return yield* Effect.succeed({ id: "1" });
  });

  it("fills a required key the author never wrote a field for", () => {
    expect(
      defineStep({
        ...METADATA,
        input: Schema.Struct({ to: Schema.String, body: Schema.String }),
        output: anOutput,
        configFields: [{ key: "to", label: "To", type: "template-input" }],
        handler: noop,
      }).configFields
    ).toEqual([
      { key: "to", label: "To", type: "template-input", required: true },
      { key: "body", label: "Body", type: "template-input", required: true },
    ]);
  });

  // The author's list is the spine, so a group draws where they put it rather
  // than wherever the key order would have placed its fields.
  it("keeps a group where the author put it, filling its fields from the schema", () => {
    expect(
      defineStep({
        ...METADATA,
        input: Schema.Struct({ to: Schema.String, body: Schema.String }),
        output: anOutput,
        configFields: [
          {
            type: "group",
            label: "Message",
            fields: [{ key: "body", type: "template-textarea", rows: 4 }],
          },
          { key: "to", label: "To", type: "template-input" },
        ],
        handler: noop,
      }).configFields
    ).toEqual([
      {
        type: "group",
        label: "Message",
        fields: [
          {
            key: "body",
            label: "Body",
            type: "template-textarea",
            rows: 4,
            required: true,
          },
        ],
      },
      { key: "to", label: "To", type: "template-input", required: true },
    ]);
  });

  // `options` belongs to a select and `min` to a number. Either riding along
  // onto a field the author respelled would be a value nothing renders.
  it("drops the derived extras when the author names a different type", () => {
    expect(
      defineStep({
        ...METADATA,
        input: Schema.Struct({
          mode: Schema.Literals(["log", "send"]),
        }),
        output: anOutput,
        configFields: [{ key: "mode", type: "text" }],
        handler: noop,
      }).configFields
    ).toEqual([{ key: "mode", label: "Mode", type: "text", required: true }]);
  });

  // The whole point of writing a field down is to say the one thing the schema
  // cannot. Everything else, the label and the required flag here, still comes
  // from the schema.
  it("takes the schema's label for an author who states only a placeholder", () => {
    expect(
      defineStep({
        ...METADATA,
        input: Schema.Struct({
          to: Schema.String.annotate({ description: "Recipient" }),
        }),
        output: anOutput,
        configFields: [{ key: "to", placeholder: "+15551234567" }],
        handler: noop,
      }).configFields
    ).toEqual([
      {
        key: "to",
        label: "Recipient",
        type: "template-input",
        required: true,
        placeholder: "+15551234567",
      },
    ]);
  });
});
