import { afterEach, describe, expect, test } from "vitest";
import { trace } from "@opentelemetry/api";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  recordSpans,
  type SpanRecording,
} from "#src/backend/lib/effect/span-test-support";
import { SilentAppLoggerLayer } from "#src/backend/lib/effect/test-layers";
import { TracerBridgeLayer } from "#src/backend/lib/effect/tracer";

const tracedWork = Effect.fn("traced.work")(function* () {
  return yield* Effect.succeed("ok");
});

let spans: SpanRecording | undefined;

// The registration is process-wide, and the API refuses a second one while the
// first stands, so each case leaves the global as it found it. `stop` shuts the
// provider down; the bare disable is for the case that registers none.
afterEach(async () => {
  await spans?.stop();
  spans = undefined;
  trace.disable();
});

describe("TracerBridgeLayer", () => {
  test("sends an Effect.fn span to the provider the host registered", async () => {
    spans = recordSpans();

    // Merged beside another layer the way `runtime.ts` merges it, because what
    // this contributes is a reference rather than a service of its own.
    {
      await using runtime = ManagedRuntime.make(
        Layer.mergeAll(TracerBridgeLayer, SilentAppLoggerLayer)
      );

      const result = await runtime.runPromise(tracedWork());
      expect(result).toBe("ok");
    }

    const span = await spans.named("traced.work");
    expect(span).toBeDefined();
    expect(span?.instrumentationScope.name).toBe("wfgraph-workflows");
  });

  test("preserves Effect.withSpan attributes and error recording", async () => {
    spans = recordSpans();

    const failure = new Error("test failure");
    const traced = Effect.fail(failure).pipe(
      Effect.withSpan("test.failing", {
        attributes: {
          "test.attr": "fail",
        },
      }),
      Effect.provide(TracerBridgeLayer)
    );

    await expect(Effect.runPromise(traced)).rejects.toBe(failure);

    const span = await spans.named("test.failing");
    expect(span).toBeDefined();
    expect(span?.attributes["test.attr"]).toBe("fail");
    expect(span?.attributes.missing).toBeUndefined();
    expect(span?.status).toEqual({ code: 2, message: "test failure" });
    expect(span?.events.map((event) => event.name)).toEqual(["exception"]);
    expect(span?.instrumentationScope).toMatchObject({
      name: "wfgraph-workflows",
      version: "0.1.0",
    });
  });

  test("runs with no provider registered", async () => {
    await using runtime = ManagedRuntime.make(TracerBridgeLayer);

    await expect(runtime.runPromise(tracedWork())).resolves.toBe("ok");
  });
});
