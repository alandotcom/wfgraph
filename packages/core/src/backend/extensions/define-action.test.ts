/**
 * The fixtures here are Zod and arktype, deliberately, and both are
 * devDependencies of this package for no other reason. `defineAction` takes any
 * Standard Schema, and writing these against the library the repo itself uses
 * would leave that claim untested: a schema built by Effect would only prove it
 * works with the shape Effect produces. The Effect cases sit beside them because
 * an Effect schema is the one arm `defineAction` bridges itself.
 */

import { Effect, Schema, SchemaTransformation } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type } from "arktype";
import { z } from "zod";
import type { NodeSteps } from "@wfgraph/shared/actions/step-result";
import { stubStepEnvironment } from "#src/backend/lib/effect/test-layers";
import {
  type ActionDefinition,
  type ActionBag,
  defineAction,
} from "#src/backend/extensions/define-action";
import { StepFailure } from "#src/backend/extensions/steps/define-step";
import { CredentialsUnavailable } from "#src/backend/extensions/credential-fetcher";

const stepContext = {
  executionId: "exec_1",
  nodeId: "node_1",
  nodeName: "Notify",
  nodeType: "action",
  runMode: "live" as const,
};

/** The action as the engine calls it: the step the app has already bound. */
function run(action: ActionDefinition) {
  const step = action.implement(stubStepEnvironment());
  return (input: Record<string, unknown>, steps?: NodeSteps) =>
    Effect.runPromise(step(input, steps));
}

/** One call through the whole seam, with the context the engine always supplies. */
function call(action: ActionDefinition, config: Record<string, unknown> = {}) {
  return run(action)({ ...config, _context: stepContext });
}

describe("defineAction", () => {
  it("validates config with the input schema and runs the handler with the typed input", async () => {
    const action = defineAction({
      id: "custom/echo",
      label: "Echo",
      description: "Echoes text input",
      input: z.object({
        text: z.string().trim().min(1),
      }),
      handler({ input }) {
        return { text: input.text };
      },
    });

    expect(await call(action, { text: " hello " })).toEqual({
      success: true,
      data: { text: "hello" },
    });
  });

  it("returns a failure result when config does not match the input schema", async () => {
    const action = defineAction({
      id: "custom/requires-text",
      label: "Requires Text",
      description: "Requires a text value",
      input: z.object({
        text: z.string().trim().min(1),
      }),
      handler() {
        return {};
      },
    });

    expect(await call(action, { text: "" })).toEqual({
      success: false,
      error: {
        message:
          'Action "custom/requires-text" received an invalid configuration: text',
      },
    });
  });

  // A handler fails its node by throwing, which is the Promise-shaped half of
  // what a step's `Effect.fail(new StepFailure(...))` does.
  it("returns a failure result when the handler throws", async () => {
    const action = defineAction({
      id: "custom/throws",
      label: "Throws",
      description: "Always throws",
      input: z.object({ text: z.string() }),
      handler() {
        throw new Error("boom");
      },
    });

    expect(await call(action, { text: "hello" })).toEqual({
      success: false,
      error: { message: "boom" },
    });
  });

  // The third handler shape. An Effect is not a thenable, so a boundary reaching
  // its value has to run it: awaiting one answers with the Effect object, which
  // reads as an empty node output everywhere downstream.
  it("runs a handler written as an Effect", async () => {
    const action = defineAction({
      id: "custom/effect-handler",
      label: "Effect Handler",
      description: "Answers from an Effect rather than a Promise",
      input: z.object({ text: z.string() }),
      handler: Effect.fn(function* () {
        return yield* Effect.succeed({ ok: true });
      }),
    });

    expect(await call(action, { text: "hello" })).toEqual({
      success: true,
      data: { ok: true },
    });
  });

  // An Effect handler fails its node with `StepFailure`, which is the arm a
  // throw covers for a plain function.
  it("fails the node on a StepFailure an Effect handler raises", async () => {
    const action = defineAction({
      id: "custom/effect-fails",
      label: "Effect Fails",
      description: "Raises a StepFailure",
      input: z.object({ text: z.string() }),
      handler: Effect.fn(function* () {
        return yield* new StepFailure({ message: "the vendor said no" });
      }),
    });

    expect(await call(action, { text: "hello" })).toEqual({
      success: false,
      error: { message: "the vendor said no" },
    });
  });
});

describe("defineAction with an output schema", () => {
  // Without `NoInfer` on the handler the schemas stop being the source of truth:
  // an action answering with fewer fields than `output` declares would make the
  // schema answer to the handler, and the editor would then offer a field the
  // run never produces.
  it("refuses a handler that answers with less than its output schema declares", () => {
    const build = () =>
      defineAction({
        id: "appointments/cancel",
        label: "Cancel",
        description: "Cancels an appointment",
        input: z.object({ appointmentId: z.string() }),
        // @ts-expect-error the handler below drops `cancelledAt`
        output: z.object({
          appointmentId: z.string(),
          status: z.string(),
          cancelledAt: z.iso.datetime(),
        }),
        handler({ input }) {
          return { appointmentId: input.appointmentId, status: "cancelled" };
        },
      });

    expect(build).toBeTypeOf("function");
  });

  const timestamps = Schema.Struct({
    at: Schema.String.pipe(
      Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString)
    ),
  });

  it("auto-derives outputFields from a Zod output schema", () => {
    const action = defineAction({
      id: "custom/typed-output",
      label: "Typed Output",
      description: "Action with typed output",
      input: z.object({ id: z.string() }),
      output: z.object({
        name: z.string(),
        age: z.number(),
        active: z.boolean(),
      }),
      handler() {
        return { name: "Alice", age: 30, active: true };
      },
    });

    expect(action.outputFields).toBeDefined();
    const fields = action.outputFields ?? [];
    expect(fields.length).toBe(3);

    const nameField = fields.find((f) => f.path === "name");
    expect(nameField).toBeDefined();
    expect(nameField?.type).toBe("string");

    const ageField = fields.find((f) => f.path === "age");
    expect(ageField).toBeDefined();
    expect(ageField?.type).toBe("number");

    const activeField = fields.find((f) => f.path === "active");
    expect(activeField).toBeDefined();
    expect(activeField?.type).toBe("boolean");
  });

  // The default is what an author who named no category gets, and it is the group
  // heading the action selector lists them under.
  it("defaults an action with no category to Custom", () => {
    const action = defineAction({
      id: "custom/uncategorized",
      label: "Uncategorized",
      description: "Names no category",
      input: z.object({ value: z.string() }),
      handler() {
        return {};
      },
    });

    expect(action.category).toBe("Custom");
  });

  // An action that says nothing only reads, which is what lets a Group hold it.
  // Declaring the side effect is how a send keeps itself out of a frame.
  it("defaults an action with no declared side effect to none", () => {
    const reads = defineAction({
      id: "custom/reads",
      label: "Reads",
      description: "Declares nothing",
      input: z.object({ value: z.string() }),
      handler() {
        return {};
      },
    });
    const writes = defineAction({
      id: "custom/writes",
      label: "Writes",
      description: "Declares a side effect",
      sideEffect: true,
      input: z.object({ value: z.string() }),
      handler() {
        return {};
      },
    });

    expect(reads.sideEffect).toBe(false);
    expect(writes.sideEffect).toBe(true);
  });

  // Only an Effect output schema carries an encoder, and this is what it buys: a
  // `Date` reaching the memoized result would come back a string on the replay.
  it("encodes the handler's answer through an Effect output schema", async () => {
    const action = defineAction({
      id: "custom/encodes",
      label: "Encodes",
      description: "Answers with a Date the schema turns into a string",
      input: Schema.Struct({}),
      output: timestamps,
      handler() {
        return { at: new Date("2026-03-01T10:00:00Z") };
      },
    });

    expect(await call(action)).toEqual({
      success: true,
      data: { at: "2026-03-01T10:00:00.000Z" },
    });
  });

  // A handler answering with something the schema cannot encode will answer with
  // it again on every attempt, so the node fails once rather than spending the
  // retry budget on a certainty. `defineStep` words the same mistake the same way.
  it("fails the node when the answer does not fit the output schema", async () => {
    const action = defineAction({
      id: "custom/cannot-encode",
      label: "Cannot Encode",
      description: "Answers outside its own output schema",
      input: Schema.Struct({}),
      output: timestamps,
      handler() {
        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the lie this case is about
        return { at: "not a date" } as unknown as { at: Date };
      },
    });

    expect(await call(action)).toEqual({
      success: false,
      error: {
        message:
          'Action "custom/cannot-encode" returned a value its output schema cannot encode: at: Expected a valid value',
      },
    });
  });

  // A foreign output has no encode direction, but `~standard.validate` still
  // runs, and Zod's default object returns only the declared keys.
  it("trims undeclared keys through a Zod output schema", async () => {
    const action = defineAction({
      id: "custom/zod-trim",
      label: "Zod Trim",
      description: "Answers with more than its Zod output declares",
      input: z.object({}),
      output: z.object({ id: z.string() }),
      handler() {
        return {
          id: "public-123",
          apiToken: "should-not-leak",
        } as { id: string };
      },
    });

    expect(await call(action)).toEqual({
      success: true,
      data: { id: "public-123" },
    });
  });

  it("fails the node when a Zod output schema refuses the answer", async () => {
    const action = defineAction({
      id: "custom/zod-refuse",
      label: "Zod Refuse",
      description: "Answers outside its Zod output schema",
      input: z.object({}),
      output: z.object({ id: z.string() }),
      handler() {
        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the lie this case is about
        return { id: 7 } as unknown as { id: string };
      },
    });

    expect(await call(action)).toEqual({
      success: false,
      error: {
        message:
          'Action "custom/zod-refuse" returned a value its output schema does not accept: id',
      },
    });
  });
});

/**
 * What the engine's dispatch hands the handler, and what it keeps back.
 */
describe("defineAction as the engine calls it", () => {
  const handler = vi.fn<
    (bag: ActionBag<Record<string, unknown>>) => Record<string, unknown>
  >(() => ({ ok: true }));

  function notify() {
    handler.mockClear();
    return defineAction({
      id: "billing/notify",
      label: "Notify",
      description: "Records what it was handed",
      input: Schema.StructWithRest(Schema.Struct({}), [
        Schema.Record(Schema.String, Schema.Unknown),
      ]),
      handler,
    });
  }

  // An input with no context is a Workflow Graph bug rather than something a host wrote,
  // and running anyway would hand an author the node ids they were promised as
  // empty strings.
  it("fails the node rather than calling the handler without a context", async () => {
    const action = notify();

    expect(await run(action)({ to: "someone" })).toEqual({
      success: false,
      error: {
        message:
          'Action "billing/notify" was called without a step context, so the node it belongs to cannot be identified.',
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  // The connection reaches the handler beside its config rather than inside it,
  // as the id and as the two credential reads a step's handler is given.
  it("keeps the connection out of the config the handler reads", async () => {
    const action = notify();

    await run(action)({
      _context: stepContext,
      actionId: "billing/notify",
      actionType: "billing",
      integrationId: "int_9",
      to: "someone",
    });

    expect(handler).toHaveBeenCalledWith({
      input: { actionId: "billing/notify", to: "someone" },
      ...stepContext,
      integrationId: "int_9",
      idempotencyKey: "exec_1:node_1",
      credentials: expect.anything(),
      readCredentials: expect.any(Function),
      step: { run: expect.any(Function), idempotencyKey: expect.any(Function) },
    });
  });

  // An action belonging to no connection is the normal case for a host action,
  // and an empty string is what a config field a builder never filled in leaves
  // behind. Both read as no connection rather than as one named "".
  it("reads a blank connection as none at all", async () => {
    for (const integrationId of ["", undefined, 7]) {
      const action = notify();

      await run(action)({ _context: stepContext, integrationId, to: "x" });

      expect(handler.mock.calls[0]?.[0].integrationId).toBeUndefined();
    }
  });

  // The context the engine wrote may leave `runMode` out, and a handler deciding
  // whether to touch a real vendor cannot be handed nothing.
  it("defaults an absent runMode to live", async () => {
    const action = notify();

    await run(action)({
      _context: {
        executionId: "exec_1",
        nodeId: "n1",
        nodeName: "Notify",
        nodeType: "action",
      },
    });

    expect(handler.mock.calls[0]?.[0].runMode).toBe("live");
  });

  // The idempotency key is derived from the run and the node, so a context
  // naming no run cannot give a handler the key it was promised.
  it("fails the node rather than calling the handler without a run id", async () => {
    const action = notify();

    const answer = await run(action)({
      _context: { nodeId: "n1", nodeName: "Notify", nodeType: "action" },
    });

    expect(answer).toMatchObject({
      success: false,
      error: { message: expect.stringContaining("without a step context") },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

/**
 * The schema seam: what an author hands `defineAction`, and what it does with the
 * schema before anything reads it.
 */
describe("defineAction bridges the schema it is given", () => {
  it("bridges a bare Effect schema without touching it", () => {
    const schema = Schema.Struct({ text: Schema.String });

    const action = defineAction({
      id: "effect/bridge-test",
      label: "Effect Bridge",
      description: "Tests that defineAction bridges what it is handed",
      input: schema,
      handler({ input }) {
        return { echo: input.text };
      },
    });

    // Effect's bridge returns a copy, so the author's schema stays as written
    // while the form fields are derived from the bridged half.
    expect("~standard" in schema).toBe(false);
    expect(action.configFields).toEqual([
      { key: "text", label: "Text", type: "template-input", required: true },
    ]);
  });

  it("leaves a Zod schema exactly as it arrived", () => {
    // The library-agnostic arm: nothing is wrapped, nothing is assigned onto it,
    // and the derivation reads the same `~standard` Zod built.
    const schema = z.object({ text: z.string() });
    const before = schema["~standard"];

    const action = defineAction({
      id: "zod/bridge-test",
      label: "Zod Bridge",
      description: "Tests that defineAction passes Zod through",
      input: schema,
      handler({ input }) {
        return { echo: input.text };
      },
    });

    expect(schema["~standard"]).toBe(before);
    expect(schema["~standard"].vendor).toBe("zod");
    expect(action.configFields).toEqual([
      { key: "text", label: "Text", type: "template-input", required: true },
    ]);
  });
});

/**
 * The Effect arm written the way an author writes one: `input: Schema.Struct(...)`,
 * no wrapper.
 */
describe("defineAction with Effect schemas", () => {
  it("derives configFields from an Effect input schema", () => {
    const action = defineAction({
      id: "effect/input-test",
      label: "Effect Input Test",
      description: "Tests Effect input schema derivation",
      input: Schema.Struct({
        name: Schema.String.annotate({
          title: "Full name",
          description: "The person's full name.",
        }),
        // `Schema.Finite`, not `Schema.Number`: Effect renders an unbounded
        // number as an `anyOf` that also admits "Infinity" and "NaN" strings,
        // and the field reader sees no single type in that.
        count: Schema.Finite,
        tone: Schema.Literals(["warm", "cool"]),
        note: Schema.optionalKey(Schema.String),
      }),
      handler({ input }) {
        return { echo: input.name };
      },
    });

    expect(action.configFields).toEqual([
      {
        key: "name",
        label: "Full name",
        description: "The person's full name.",
        type: "template-input",
        required: true,
      },
      { key: "count", label: "Count", type: "number", required: true },
      {
        key: "tone",
        label: "Tone",
        type: "select",
        required: true,
        options: [
          { value: "warm", label: "warm" },
          { value: "cool", label: "cool" },
        ],
      },
      { key: "note", label: "Note", type: "template-input" },
    ]);
  });

  it("derives outputFields from an Effect output schema", () => {
    const action = defineAction({
      id: "effect/output-test",
      label: "Effect Output Test",
      description: "Tests Effect output schema derivation",
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.Struct({
        name: Schema.String,
        nickname: Schema.NullOr(Schema.String),
      }),
      handler() {
        return { name: "Test", nickname: null };
      },
    });

    const fields = action.outputFields ?? [];
    expect(fields.find((f) => f.path === "name")?.type).toBe("string");
    expect(fields.find((f) => f.path === "nickname")?.type).toBe("string");
    expect(fields.find((f) => f.path === "nickname")?.nullable).toBe(true);
  });

  // The same codec that encodes an Effect output decodes an Effect input, so a
  // transform an author wrote runs on the way in as well as on the way out.
  // `defineStep` reads its config through the one reader this shares with.
  it("runs an input transform on the way in", async () => {
    const action = defineAction({
      id: "effect/decode-test",
      label: "Effect Decode",
      description: "Takes a text field its schema turns into a Date",
      input: Schema.Struct({
        at: Schema.String.pipe(
          Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString)
        ),
      }),
      handler({ input }) {
        return { year: input.at.getUTCFullYear() };
      },
    });

    expect(await call(action, { at: "2026-03-01T10:00:00Z" })).toEqual({
      success: true,
      data: { year: 2026 },
    });
  });

  it("validates the config before the handler sees it", async () => {
    const action = defineAction({
      id: "effect/validate-test",
      label: "Effect Validate",
      description: "Tests Effect validation",
      input: Schema.Struct({
        text: Schema.String.check(Schema.isMinLength(1)),
      }),
      handler({ input }) {
        return { echo: input.text };
      },
    });

    expect((await call(action, { text: "hello" })).success).toBe(true);
    expect((await call(action, { text: "" })).success).toBe(false);
  });
});

describe("defineAction with Arktype schemas", () => {
  it("derives configFields from an Arktype input schema", () => {
    const action = defineAction({
      id: "arktype/input-test",
      label: "Arktype Input Test",
      description: "Tests Arktype input schema derivation",
      input: type({
        name: "string",
        count: "number",
      }),
      handler() {
        return {};
      },
    });

    const fields = action.configFields ?? [];
    expect(fields.length).toBe(2);

    const nameField = fields.find((f) => "key" in f && f.key === "name");
    expect(nameField).toBeDefined();
    expect(nameField && "type" in nameField ? nameField.type : undefined).toBe(
      "template-input"
    );

    const countField = fields.find((f) => "key" in f && f.key === "count");
    expect(countField).toBeDefined();
    expect(
      countField && "type" in countField ? countField.type : undefined
    ).toBe("number");
  });

  it("derives a select from an Arktype enumerated input", () => {
    const action = defineAction({
      id: "arktype/enum-input-test",
      label: "Arktype Enum Input Test",
      description: "Tests Arktype enumerated input schema derivation",
      input: type({
        choice: type.enumerated("alpha", "beta").describe("Choice"),
      }),
      handler() {
        return {};
      },
    });

    expect(action.configFields).toEqual([
      {
        key: "choice",
        label: "Choice",
        description: "Choice",
        type: "select",
        options: [
          { value: "alpha", label: "alpha" },
          { value: "beta", label: "beta" },
        ],
        required: true,
      },
    ]);
  });

  it("derives outputFields from an Arktype date the schema gave a format", () => {
    // The derivation compiles the encoded side, and the encoded side of an Arktype
    // date morph is its ISO string, which carries a pattern and no keyword.
    // `.configure({ format })` is how an Arktype author says the string is a
    // moment in time, the same one keyword every other library carries.
    const action = defineAction({
      id: "arktype/output-date-test",
      label: "Arktype Output Date Test",
      description: "Tests Arktype output schema with date.parse",
      input: type({ id: "string" }),
      output: type({
        name: "string",
        createdAt: type("string.date.iso.parse").configure({
          format: "date-time",
        }),
      }),
      handler() {
        return { name: "Test", createdAt: new Date() };
      },
    });

    const fields = action.outputFields ?? [];
    expect(fields.length).toBe(2);

    const nameField = fields.find((f) => f.path === "name");
    expect(nameField).toBeDefined();
    expect(nameField?.type).toBe("string");

    const createdAtField = fields.find((f) => f.path === "createdAt");
    expect(createdAtField).toBeDefined();
    expect(createdAtField?.type).toBe("timestamp");
  });

  it("does not crash when an Arktype output schema has predicate types", () => {
    const action = defineAction({
      id: "arktype/predicate-test",
      label: "Arktype Predicate Test",
      description: "Tests Arktype output schema with predicate",
      input: type({ id: "string" }),
      output: type({
        dateStr: "string.date",
        name: "string",
      }),
      handler() {
        return { dateStr: "2026-01-01", name: "Test" };
      },
    });

    const fields = action.outputFields ?? [];
    expect(fields.length).toBe(2);
    expect(fields.find((f) => f.path === "name")?.type).toBe("string");
    expect(fields.find((f) => f.path === "dateStr")?.type).toBe("string");
  });

  it("derives outputFields from an Arktype output schema with nullable fields", () => {
    const action = defineAction({
      id: "arktype/nullable-output-test",
      label: "Arktype Nullable Output Test",
      description: "Tests that nullable fields appear in outputFields",
      input: type({ donorUuid: "string" }),
      output: type({
        uuid: "string",
        firstName: "string",
        "middleInitial?": "string | null",
        email: "string",
        "phone?": "string | null",
        dateOfBirth: type("string.date.iso")
          .configure({ format: "date-time" })
          .or("null"),
        bloodType: "'A' | 'B' | 'AB' | 'O' | null",
        hasPermanentDeferral: "boolean",
        createdAt: type("string.date.iso").configure({ format: "date-time" }),
      }),
      // Answers the shape the schema declares. It never runs here: what this
      // case reads is the field list derived from `output`.
      handler() {
        return {
          uuid: "u_1",
          firstName: "Ada",
          email: "ada@example.com",
          dateOfBirth: null,
          bloodType: "O" as const,
          hasPermanentDeferral: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    const fields = action.outputFields ?? [];
    const fieldNames = fields.map((f) => f.path).sort();

    expect(fieldNames).toContain("uuid");
    expect(fieldNames).toContain("firstName");
    expect(fieldNames).toContain("middleInitial");
    expect(fieldNames).toContain("email");
    expect(fieldNames).toContain("phone");
    expect(fieldNames).toContain("dateOfBirth");
    expect(fieldNames).toContain("bloodType");
    expect(fieldNames).toContain("hasPermanentDeferral");
    expect(fieldNames).toContain("createdAt");
    expect(fields).toHaveLength(9);

    // A date field carrying the keyword is a timestamp on either side of a null.
    expect(fields.find((f) => f.path === "dateOfBirth")?.type).toBe(
      "timestamp"
    );
    expect(fields.find((f) => f.path === "createdAt")?.type).toBe("timestamp");
  });

  it("validates the config with an Arktype schema", async () => {
    const action = defineAction({
      id: "arktype/validate-test",
      label: "Arktype Validate",
      description: "Tests Arktype validation",
      input: type({
        text: "string > 0",
      }),
      handler({ input }) {
        return { echo: input.text };
      },
    });

    expect((await call(action, { text: "hello" })).success).toBe(true);
    expect((await call(action, { text: "" })).success).toBe(false);
  });
});

/**
 * A memo over a map, as the in-memory runtime keeps one: a step whose work
 * answered is stored as JSON under its id and answered from there afterwards,
 * and a step whose work threw stores nothing. `ids` lists every step a pass
 * ran, so a case can see that the handler's own step nests the author's.
 */
function memoSteps(memo: Map<string, unknown>) {
  const ids: string[] = [];
  const remember = async <T>(id: string, work: () => Promise<T>) => {
    if (memo.has(id)) {
      return memo.get(id) as T;
    }
    ids.push(id);
    const value = await work();
    memo.set(id, JSON.parse(JSON.stringify(value ?? null)));
    return value;
  };
  const steps: NodeSteps = {
    run: (stepId, work) => remember(`step:${stepId}`, work),
    runHandler: (work) => remember("handler", work),
  };
  return { steps, ids };
}

/**
 * A host action's handler runs inside one durable step of its node, so a
 * handler that answered once is not called again for that node of that run,
 * whether or not it put anything in `step.run`.
 */
describe("defineAction across passes", () => {
  it("calls a handler that answered once on no later pass, and answers what it stored", async () => {
    let calls = 0;
    const action = defineAction({
      id: "billing/refund",
      label: "Refund",
      description: "Refunds outside any step",
      input: Schema.Struct({}),
      output: Schema.Struct({ refundId: Schema.String }),
      handler: () => {
        calls += 1;
        return { refundId: `re_${calls}` };
      },
    });
    const memo = new Map<string, unknown>();

    const first = await run(action)(
      { _context: stepContext },
      memoSteps(memo).steps
    );
    const second = await run(action)(
      { _context: stepContext },
      memoSteps(memo).steps
    );

    expect(first).toEqual({ success: true, data: { refundId: "re_1" } });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(memo.get("handler")).toEqual({
      ok: true,
      value: { refundId: "re_1" },
    });
  });

  it("nests the author's steps inside the handler's step", async () => {
    const action = defineAction({
      id: "billing/refund",
      label: "Refund",
      description: "Refunds in a step",
      input: Schema.Struct({}),
      handler: async ({ step }) => ({
        refundId: await step.run("refund", async () => "re_1"),
      }),
    });
    const { steps, ids } = memoSteps(new Map());

    await run(action)({ _context: stepContext }, steps);

    expect(ids).toEqual(["handler", "step:refund"]);
  });

  // A throw outside any step is an answer the node settles on, so it is
  // stored and raised again rather than retried as a step.
  it("fails the node once for a throw outside any step, and calls the handler on no later pass", async () => {
    let calls = 0;
    const action = defineAction({
      id: "billing/refund",
      label: "Refund",
      description: "Refuses outside any step",
      input: Schema.Struct({}),
      handler: () => {
        calls += 1;
        throw new Error("The charge is already refunded");
      },
    });
    const memo = new Map<string, unknown>();

    const first = await run(action)(
      { _context: stepContext },
      memoSteps(memo).steps
    );
    const second = await run(action)(
      { _context: stepContext },
      memoSteps(memo).steps
    );

    expect(first).toEqual({
      success: false,
      error: { message: "The charge is already refunded" },
    });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it("stores an Effect handler's StepFailure as the node's failure", async () => {
    let calls = 0;
    const action = defineAction({
      id: "billing/refund",
      label: "Refund",
      description: "Refuses with a StepFailure",
      input: Schema.Struct({}),
      handler: () =>
        Effect.suspend(() => {
          calls += 1;
          return Effect.fail(new StepFailure({ message: "Refused" }));
        }),
    });
    const memo = new Map<string, unknown>();

    await run(action)({ _context: stepContext }, memoSteps(memo).steps);
    const second = await run(action)(
      { _context: stepContext },
      memoSteps(memo).steps
    );

    expect(second).toEqual({ success: false, error: { message: "Refused" } });
    expect(calls).toBe(1);
  });

  // A throw inside `step.run` is a step the runtime retries. The handler's
  // step stores nothing on that pass, and the next pass calls the handler
  // again with the steps that finished answered from the memo.
  it("stores nothing when a step's work threw, and resumes past the steps that finished", async () => {
    const work = { charge: 0, receipt: 0, handler: 0 };
    const action = defineAction({
      id: "billing/charge",
      label: "Charge",
      description: "Charges, then sends a receipt that fails once",
      input: Schema.Struct({}),
      handler: async ({ step }) => {
        work.handler += 1;
        const chargeId = await step.run("charge", async () => {
          work.charge += 1;
          return "ch_1";
        });
        await step.run("receipt", async () => {
          work.receipt += 1;
          if (work.receipt === 1) throw new Error("The mailer timed out");
          return null;
        });
        return { chargeId };
      },
    });
    const memo = new Map<string, unknown>();
    const pass = () =>
      run(action)({ _context: stepContext }, memoSteps(memo).steps);

    await expect(pass()).rejects.toThrow("The mailer timed out");
    expect(memo.has("handler")).toBe(false);

    expect(await pass()).toEqual({
      success: true,
      data: { chargeId: "ch_1" },
    });
    expect(await pass()).toEqual({
      success: true,
      data: { chargeId: "ch_1" },
    });
    expect(work).toEqual({ charge: 1, receipt: 2, handler: 2 });
  });

  // A refused credential read stays the store's failure on every pass, which
  // the dispatch port turns into an engine failure naming the store.
  it("raises a refused credential read again as the store's failure", async () => {
    let calls = 0;
    const action = defineAction({
      id: "billing/refund",
      label: "Refund",
      description: "Reads a Connection",
      input: Schema.Struct({}),
      handler: async ({ readCredentials }) => {
        calls += 1;
        await readCredentials();
        return {};
      },
    });
    const refusing = action.implement(
      stubStepEnvironment({
        credentialsFor: (integrationId) =>
          Effect.fail(
            new CredentialsUnavailable({
              integrationId,
              message: "The credential store is unreachable",
            })
          ),
      })
    );
    const memo = new Map<string, unknown>();
    const pass = () =>
      Effect.runPromise(
        Effect.flip(
          refusing(
            { _context: stepContext, integrationId: "int_1" },
            memoSteps(memo).steps
          )
        )
      );

    const first = await pass();
    const second = await pass();

    expect(first).toBeInstanceOf(CredentialsUnavailable);
    expect(second).toBeInstanceOf(CredentialsUnavailable);
    expect(second.message).toBe("The credential store is unreachable");
    expect(calls).toBe(1);
  });
});
