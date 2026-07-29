import { Effect, Schema } from "effect";
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
    id: "demo/send",
    input,
    output,
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

  it("answers the envelope the engine reads, carrying the handler's payload", async () => {
    const result = await step.run({
      to: "someone",
      integrationId: "int_1",
      _context: CONTEXT,
    });

    expect(result).toEqual({
      success: true,
      data: { id: "k-1", sentTo: "someone" },
    });
  });

  it("fetches the integration's credentials once, however often they are read", async () => {
    await step.run({
      to: "someone",
      integrationId: "int_1",
      _context: CONTEXT,
    });

    expect(mocks.fetchCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.fetchCredentials).toHaveBeenCalledWith("int_1");
  });

  it("fetches nothing for a step no integration was configured for", async () => {
    const result = await step.run({ to: "someone", _context: CONTEXT });

    expect(mocks.fetchCredentials).toHaveBeenCalledTimes(0);
    expect(result).toEqual({
      success: false,
      error: { message: "API_KEY is not configured." },
    });
  });

  it("never asks for credentials a handler does not read", async () => {
    const quiet = defineStep({
      id: "demo/quiet",
      input,
      output,
      handler: Effect.fn(function* (config) {
        return yield* Effect.succeed({ id: "fixed", sentTo: config.to });
      }),
    });

    await quiet.run({
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
    const result = await step.run({
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
    const result = await step.run({
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
    await step.run({
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
    await step.run({
      to: "someone",
      integrationId: "int_1",
      _context: CONTEXT,
    });

    expect(mocks.logStepCompleteDb).toHaveBeenCalledWith({
      logId: "log_1",
      startTime: 10,
      status: "success",
      output: { id: "k-1", sentTo: "someone" },
      error: undefined,
    });

    vi.clearAllMocks();
    mocks.logStepStartDb.mockResolvedValue({ logId: "log_2", startTime: 20 });

    await step.run({ to: "someone", _context: CONTEXT });

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
      id: "demo/mode",
      input,
      output,
      handler: Effect.fn(function* (config, context) {
        modes.push(context.runMode);
        return yield* Effect.succeed({ id: "x", sentTo: config.to });
      }),
    });

    // The three ways a mode reaches a handler: named, named as an empty key,
    // and absent along with the rest of the context. Only the last two default.
    await reporting.run({ to: "a", _context: { ...CONTEXT, runMode: "test" } });
    await reporting.run({
      to: "a",
      _context: { ...CONTEXT, runMode: undefined },
    });
    await reporting.run({ to: "a" });

    expect(modes).toEqual(["test", "live", "live"]);
  });

  // A key present holding `undefined` is what a caller building the context
  // from optional values sends, and the context schema accepts it. It used to
  // fail the decode, which threw the whole context away: the run stopped
  // logging, and a test run read as a live one.
  it("keeps the run context when a field arrives as an empty key", async () => {
    await step.run({
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
