/**
 * Task check for the wfgraph-core/observability skill, tracing half: a host
 * sends Workflow Graph's spans to its own tracing backend. Workflow Graph
 * starts no OpenTelemetry SDK and opens its spans on the global API, so the
 * developer task is registering a provider there. An in-memory exporter
 * stands in for the backend.
 *
 * `expectRunTraced` is the grader. It runs against the registered provider
 * the skill recommends, and against the mistake it warns about (a provider
 * built and never registered), which it must reject.
 */

import { afterEach, describe, expect, it } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trustWfGraphUpstream } from "@wfgraph/core";
import {
  type FinishedRun,
  openHost,
  RECORD_ACTION_ID,
  runPublishedWorkflow,
} from "#src/skills/host";

/** A provider whose spans land in memory, and the exporter that holds them. */
function inMemoryProvider() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, provider };
}

// The global registration outlives a case, and the test workers share one
// module graph across files, so every case leaves the global API empty.
afterEach(() => {
  trace.disable();
});

/**
 * Runs one workflow on a fresh app and answers every span exported meanwhile.
 * `afterOpen` runs once the app exists and before the run starts.
 */
async function traceOneRun(
  exporter: InMemorySpanExporter,
  provider: BasicTracerProvider,
  afterOpen: () => void = () => undefined
): Promise<{ run: FinishedRun; spans: readonly ReadableSpan[] }> {
  await using app = await openHost({ auth: trustWfGraphUpstream() });
  afterOpen();
  const run = await runPublishedWorkflow(app);
  await provider.forceFlush();
  return { run, spans: exporter.getFinishedSpans() };
}

/**
 * The grader. It asserts that the run's pass arrived as a
 * `wfgraph.workflow.execution` span under the `wfgraph-workflows` scope with
 * its four documented attributes, and that its action node arrived as a
 * `wfgraph.workflow.node.execute` span naming the action type.
 */
function expectRunTraced(
  spans: readonly ReadableSpan[],
  run: FinishedRun
): void {
  const pass = spans.find(
    (span) =>
      span.name === "wfgraph.workflow.execution" &&
      span.attributes["wfgraph.execution.id"] === run.executionId
  );
  expect(pass, "no wfgraph.workflow.execution span for the run").toBeDefined();
  expect(pass?.instrumentationScope.name).toBe("wfgraph-workflows");
  expect(pass?.attributes).toMatchObject({
    "wfgraph.workflow.id": run.workflowId,
    "wfgraph.workflow.name": "Skill check",
    "wfgraph.execution.id": run.executionId,
    "wfgraph.execution.run_mode": "live",
  });

  const node = spans.find(
    (span) =>
      span.name === "wfgraph.workflow.node.execute" &&
      span.attributes["wfgraph.node.id"] === "record"
  );
  expect(node?.instrumentationScope.name).toBe("wfgraph-workflows");
  expect(node?.attributes).toMatchObject({
    "wfgraph.node.type": "action",
    "wfgraph.action.type": RECORD_ACTION_ID,
  });
}

describe("wfgraph-core/observability task check: tracing", () => {
  it("exports a run's pass and node spans to a provider registered on the global API", async () => {
    const { exporter, provider } = inMemoryProvider();
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);

    const { run, spans } = await traceOneRun(exporter, provider);
    expectRunTraced(spans, run);
    await provider.shutdown();
  });

  it("exports spans to a provider registered after the app was created", async () => {
    const { exporter, provider } = inMemoryProvider();

    const { run, spans } = await traceOneRun(exporter, provider, () => {
      expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    });
    expectRunTraced(spans, run);
    await provider.shutdown();
  });

  // The mistake the skill warns about: building an SDK provider and an
  // exporter, and expecting Workflow Graph to find them. It reads only the
  // global API, so every span is a no-op and the exporter stays empty.
  it("rejects a provider that was never registered", async () => {
    const { exporter, provider } = inMemoryProvider();

    const { run, spans } = await traceOneRun(exporter, provider);
    expect(() => expectRunTraced(spans, run)).toThrow(
      "no wfgraph.workflow.execution span for the run"
    );
    await provider.shutdown();
  });
});
