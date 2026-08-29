import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { expect } from "vitest";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";

/**
 * An in-memory OpenTelemetry provider, registered where Workflow Graph's spans look for
 * one.
 *
 * Test support rather than product code, the same as `test-layers.ts`: nothing
 * under `src` ships, and no published entry reaches this file.
 *
 * `TracerBridgeLayer` opens every span on the global proxy provider, so a test
 * that wants to read its own spans has to register a provider on the global API
 * and take it down again afterwards. The registration is process-wide and the
 * API refuses a second one while the first stands, which is why `stop` is not
 * optional: a case that skips it leaves the next file in the same worker writing
 * into this exporter.
 */
export type SpanRecording = {
  /** Flushes the processor, then answers every span that has ended so far. */
  finished: () => Promise<readonly ReadableSpan[]>;
  /** The one span with this name, or undefined. Fails loudly on a duplicate. */
  named: (name: string) => Promise<ReadableSpan | undefined>;
  /** Shuts the provider down and unregisters it. Every case must call this. */
  stop: () => Promise<void>;
};

export function recordSpans(): SpanRecording {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  // A refused registration is the symptom of a case that skipped `stop`, and it
  // is silent: the API keeps the standing provider and the spans this test reads
  // are the previous one's.
  if (!trace.setGlobalTracerProvider(provider)) {
    throw new Error(
      "A global tracer provider is already registered; an earlier test did not call stop()"
    );
  }

  const finished = async (): Promise<readonly ReadableSpan[]> => {
    await provider.forceFlush();
    return exporter.getFinishedSpans();
  };

  return {
    finished,
    named: async (name) => {
      const matches = (await finished()).filter((span) => span.name === name);
      if (matches.length > 1) {
        throw new Error(
          `Expected at most one span named "${name}", found ${matches.length}`
        );
      }
      return matches[0];
    },
    stop: async () => {
      await provider.shutdown();
      trace.disable();
    },
  };
}

/**
 * Assert that every `wfgraph.` span carries identifiers and nothing else.
 *
 * `allowed` is the whole set of attribute keys the contract permits, and
 * `forbidden` the fragments that live only in a graph or a payload, checked
 * against the rendered attributes so a value nested anywhere is caught. Each
 * suite states its own two sets, so the assertion stays an independent reading
 * of the contract rather than a restatement of `telemetry.ts`.
 */
export function expectIdentifierAttributesOnly(
  spans: readonly ReadableSpan[],
  expected: { allowed: ReadonlySet<string>; forbidden: readonly string[] }
): void {
  const wfgraphSpans = spans.filter((span) => span.name.startsWith("wfgraph."));
  expect(wfgraphSpans.length).toBeGreaterThan(0);

  for (const span of wfgraphSpans) {
    for (const key of Object.keys(span.attributes)) {
      expect(expected.allowed).toContain(key);
    }
    const rendered = JSON.stringify(span.attributes);
    for (const fragment of expected.forbidden) {
      expect(rendered).not.toContain(fragment);
    }
  }
}

/**
 * The one-Event catalog both span suites run their graphs against. Its Event
 * declares a Correlation Path, which is what makes a manual start read a value
 * out of the payload and gives the forbidden-fragment check something to catch.
 */
export const spanFixtureCatalog: ExtensionCatalog = {
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      correlationPath: "appointment.id",
      payloadFields: [],
    },
  ],
  actions: [],
  integrations: [],
};

/**
 * A graph of one Lifecycle Node carrying `rules`.
 *
 * Preflight memoises its verdict on the graph's digest, and the label is part of
 * that digest, so a case wanting its own verdict passes its own label.
 */
export function lifecycleGraphFixture(input: {
  label: string;
  rules: LifecycleRules;
}): SerializedWorkflowGraph {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle-1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          label: input.label,
          type: "lifecycle",
          config: { lifecycleRules: input.rules },
        },
      },
    ],
    edges: [],
  });
}
