import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Effect, Layer, Logger, References } from "effect";
import { noWorkflowActions } from "#src/backend/engine/actions";
import { executeTestWorkflow as executeWorkflow } from "#src/backend/engine/test-execution";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import { executeWaitAction } from "#src/backend/engine/wait";
import { TracerBridgeLayer } from "#src/backend/lib/effect/tracer";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";
import type { WorkflowNode } from "@rova/shared/graph/types";

function lifecycleNode(): WorkflowNode {
  return {
    id: "lifecycle_1",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      type: "lifecycle",
      label: "Lifecycle",
      config: {},
    },
  };
}

function actionNode(): WorkflowNode {
  return {
    id: "action_1",
    type: "action",
    position: { x: 100, y: 0 },
    data: {
      type: "action",
      label: "Unknown action",
      config: { actionType: "test/unknown" },
    },
  };
}

function recordingLogger() {
  const messages: unknown[] = [];
  const logger = Logger.make<unknown, void>(({ message }) => {
    messages.push(Array.isArray(message) ? message[0] : message);
  });
  return {
    messages,
    layer: Layer.merge(
      Logger.layer([logger]),
      Layer.succeed(References.MinimumLogLevel, "All")
    ),
  };
}

describe("engine Effect spans", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
  });

  test("preserves execution, node, and action span names and attributes", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [lifecycleNode(), actionNode()],
      edges: [
        {
          id: "edge_1",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "action_1",
        },
      ],
    });

    await executeWorkflow(
      {
        graph,
        executionId: "execution_1",
        workflowId: "workflow_1",
        workflowName: "Observed workflow",
      },
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      noWorkflowActions
    );
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const execution = spans.find(
      (span) => span.name === "rova.workflow.execution"
    );
    const lifecycle = spans.find(
      (span) =>
        span.name === "rova.workflow.node.execute" &&
        span.attributes["rova.node.id"] === "lifecycle_1"
    );
    const actionNodeSpan = spans.find(
      (span) =>
        span.name === "rova.workflow.node.execute" &&
        span.attributes["rova.node.id"] === "action_1"
    );
    const action = spans.find(
      (span) => span.name === "rova.workflow.action.execute"
    );

    expect(execution?.attributes).toMatchObject({
      "rova.workflow.id": "workflow_1",
      "rova.workflow.name": "Observed workflow",
      "rova.execution.id": "execution_1",
      "rova.execution.run_mode": "live",
    });
    expect(lifecycle?.attributes).toMatchObject({
      "rova.node.id": "lifecycle_1",
      "rova.node.name": "Lifecycle",
      "rova.node.type": "lifecycle",
    });
    expect(lifecycle?.attributes["rova.action.type"]).toBeUndefined();
    expect(actionNodeSpan?.attributes).toMatchObject({
      "rova.node.id": "action_1",
      "rova.node.name": "Unknown action",
      "rova.node.type": "action",
      "rova.action.type": "test/unknown",
    });
    expect(action?.attributes).toMatchObject({
      "rova.action.type": "test/unknown",
      "rova.node.id": "action_1",
      "rova.node.name": "Unknown action",
    });
    expect(action?.parentSpanContext?.spanId).toBe(
      actionNodeSpan?.spanContext().spanId
    );
    expect(
      spans
        .filter((span) => span.name.startsWith("rova.workflow."))
        .every(
          (span) =>
            span.instrumentationScope.name === "rova-workflows" &&
            span.instrumentationScope.version === "0.1.0"
        )
    ).toBe(true);
  });

  test("preserves the wait span name and attributes", async () => {
    const result = await Effect.runPromise(
      executeWaitAction({
        config: { waitMode: "not-supported" },
        context: {
          executionId: "execution_2",
          nodeId: "wait_1",
          nodeName: "Wait for reply",
          nodeType: "core/wait",
        },
        runtime: createInMemoryWorkflowRuntime(),
        store: createRecordingWorkflowStore(),
        workflowId: "workflow_2",
        workflowRunId: "run_2",
        resolveTemplates: (value) => value,
      }).pipe(Effect.provide(TracerBridgeLayer))
    );
    await provider.forceFlush();

    expect(result.result.success).toBe(false);
    const wait = exporter
      .getFinishedSpans()
      .find((span) => span.name === "rova.workflow.wait");
    expect(wait?.attributes).toMatchObject({
      "rova.wait.type": "delay",
      "rova.node.id": "wait_1",
      "rova.node.name": "Wait for reply",
    });
  });

  test("preserves logger and tracer context inside a Wait durable callback", async () => {
    const recording = createRecordingWorkflowStore();
    const capturedLogger = recordingLogger();
    const store = {
      ...recording,
      startStepLog: (input: Parameters<typeof recording.startStepLog>[0]) =>
        Effect.logInfo("Wait durable callback observed").pipe(
          Effect.andThen(recording.startStepLog(input)),
          Effect.withSpan("test.wait.durable")
        ),
    };

    await Effect.runPromise(
      executeWaitAction({
        config: { waitMode: "not-supported" },
        context: {
          executionId: "execution_context",
          nodeId: "wait_context",
          nodeName: "Wait context",
          nodeType: "core/wait",
        },
        runtime: createInMemoryWorkflowRuntime(),
        store,
        workflowId: "workflow_context",
        workflowRunId: "run_context",
        resolveTemplates: (value) => value,
      }).pipe(
        Effect.provide(Layer.merge(TracerBridgeLayer, capturedLogger.layer))
      )
    );
    await provider.forceFlush();

    expect(capturedLogger.messages).toContain("Wait durable callback observed");
    const spans = exporter.getFinishedSpans();
    const wait = spans.find(
      (span) =>
        span.name === "rova.workflow.wait" &&
        span.attributes["rova.node.id"] === "wait_context"
    );
    const durable = spans.find((span) => span.name === "test.wait.durable");
    expect(durable?.parentSpanContext?.spanId).toBe(wait?.spanContext().spanId);
  });
});
