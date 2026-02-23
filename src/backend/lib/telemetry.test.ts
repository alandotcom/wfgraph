import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { withSpan } from "./telemetry";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

describe("withSpan", () => {
  test("creates a span with correct name and attributes", async () => {
    exporter.reset();

    const result = await withSpan(
      "test.operation",
      { "test.attr": "value", "test.num": 42 },
      async () => "ok"
    );

    expect(result).toBe("ok");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("test.operation");
    expect(spans[0].attributes["test.attr"]).toBe("value");
    expect(spans[0].attributes["test.num"]).toBe(42);
    expect(spans[0].status.code).toBe(1); // SpanStatusCode.OK
  });

  test("records error and sets error status on failure", async () => {
    exporter.reset();

    const testError = new Error("test failure");
    const failing = (): Promise<never> =>
      withSpan("test.failing", { "test.attr": "fail" }, () =>
        Promise.reject(testError)
      );
    await expect(failing()).rejects.toThrow("test failure");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("test.failing");
    expect(spans[0].status.code).toBe(2); // SpanStatusCode.ERROR
    expect(spans[0].status.message).toBe("test failure");

    const events = spans[0].events;
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("exception");
  });

  test("omits undefined attributes", async () => {
    exporter.reset();

    await withSpan(
      "test.undefined-attrs",
      { present: "yes", missing: undefined },
      async () => "ok"
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes.present).toBe("yes");
    expect(spans[0].attributes.missing).toBeUndefined();
  });

  test("creates spans for nested calls", async () => {
    exporter.reset();

    const result = await withSpan("parent", { p: true }, async () => {
      await withSpan("child", { c: true }, async () => "inner");
      return "outer";
    });

    expect(result).toBe("outer");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);

    const child = spans.find((s) => s.name === "child");
    const parent = spans.find((s) => s.name === "parent");
    expect(child).toBeDefined();
    expect(parent).toBeDefined();
    expect(child?.attributes.c).toBe(true);
    expect(parent?.attributes.p).toBe(true);
  });

  test("returns the callback result transparently", async () => {
    const result = await withSpan(
      "passthrough.test",
      { attr: "val" },
      async () => 123
    );
    expect(result).toBe(123);
  });
});

describe("tracer singleton", () => {
  test("getTracer returns a tracer", () => {
    const tracer = trace.getTracer("test");
    expect(tracer).toBeDefined();
    expect(typeof tracer.startSpan).toBe("function");
  });
});
