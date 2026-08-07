import { afterEach, describe, expect, test } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SilentAppLoggerLayer } from "#src/backend/lib/effect/test-layers";
import { TracerBridgeLayer } from "#src/backend/lib/effect/tracer";

const tracedWork = Effect.fn("traced.work")(function* () {
  return yield* Effect.succeed("ok");
});

// The registration is process-wide, and the API refuses a second one while the
// first stands, so each case leaves the global as it found it.
afterEach(() => {
  trace.disable();
});

describe("TracerBridgeLayer", () => {
  test("sends an Effect.fn span to the provider the host registered", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);

    // Merged beside another layer the way `runtime.ts` merges it, since what
    // this contributes is a reference rather than a service of its own.
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(TracerBridgeLayer, SilentAppLoggerLayer)
    );

    const result = await runtime.runPromise(tracedWork());
    await runtime.dispose();
    await provider.forceFlush();

    expect(result).toBe("ok");

    const span = exporter
      .getFinishedSpans()
      .find((finished) => finished.name === "traced.work");
    expect(span).toBeDefined();
    expect(span?.instrumentationScope.name).toBe("wfgraph-workflows");

    await provider.shutdown();
  });

  test("preserves Effect.withSpan attributes and error recording", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);

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
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((finished) => finished.name === "test.failing");
    expect(span).toBeDefined();
    expect(span?.attributes["test.attr"]).toBe("fail");
    expect(span?.attributes.missing).toBeUndefined();
    expect(span?.status).toEqual({ code: 2, message: "test failure" });
    expect(span?.events.map((event) => event.name)).toEqual(["exception"]);
    expect(span?.instrumentationScope).toMatchObject({
      name: "wfgraph-workflows",
      version: "0.1.0",
    });

    await provider.shutdown();
  });

  test("runs with no provider registered", async () => {
    const runtime = ManagedRuntime.make(TracerBridgeLayer);

    await expect(runtime.runPromise(tracedWork())).resolves.toBe("ok");

    await runtime.dispose();
  });
});
