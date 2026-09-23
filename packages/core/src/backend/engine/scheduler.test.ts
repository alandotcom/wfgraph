import { afterAll, describe, expect, test } from "vitest";
import { Effect } from "effect";
import { NodeScheduler } from "#src/backend/engine/scheduler";
import { Traversal } from "#src/backend/engine/traversal";
import { CancelBoundary } from "#src/backend/engine/cancel-boundary";
import { resetSync } from "@logtape/logtape";
import { noWorkflowActions } from "#src/backend/engine/actions";
import { executeTestWorkflow as executeWorkflow } from "#src/backend/engine/test-execution";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import { configureLoggingWithBridge } from "#src/backend/lib/log-config";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";

function lifecycleNode(): WorkflowNode {
  return {
    id: "lifecycle_1",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { type: "lifecycle", label: "Lifecycle", config: {} },
  };
}

/**
 * Captures the `node` group of every record the scheduler wrote. The pretty
 * formatter prints one line per group, so a key present and holding `undefined`
 * reaches the reader as `key=undefined`.
 */
function captureNodeGroups(): Record<string, unknown>[] {
  const groups: Record<string, unknown>[] = [];
  const take = (properties: unknown) => {
    const group =
      typeof properties === "object" && properties !== null
        ? (properties as Record<string, unknown>)["node"]
        : undefined;
    if (typeof group === "object" && group !== null) {
      groups.push(group as Record<string, unknown>);
    }
  };
  configureLoggingWithBridge(
    {
      debug: (_message, properties) => take(properties),
      info: (_message, properties) => take(properties),
      warn: (_message, properties) => take(properties),
      error: (_message, properties) => take(properties),
    },
    "debug"
  );
  return groups;
}

describe("the node log record", () => {
  test("leaves out a key whose value is undefined", async () => {
    const nodeGroups = captureNodeGroups();
    const graph = createSerializedWorkflowGraph({
      nodes: [lifecycleNode()],
      edges: [],
    });

    await executeWorkflow(
      {
        graph,
        executionId: "execution_1",
        workflowId: "workflow_1",
        workflowName: "Logged workflow",
      },
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      noWorkflowActions
    );

    // A lifecycle node carries no action type and this one succeeded, so
    // neither `action` nor `error` holds a value.
    const completed = nodeGroups.find((group) => group["status"] === "success");
    expect(completed).toBeDefined();
    expect(Object.keys(completed ?? {})).toEqual([
      "id",
      "name",
      "type",
      "status",
      "ms",
    ]);
  });
});

// Back to unconfigured, which is logtape's own default and what every other
// file in this worker expects: the suite shares one module graph.
afterAll(() => {
  resetSync();
});

test("two predecessors admit and execute their join only once", async () => {
  const nodes: WorkflowNode[] = [
    lifecycleNode(),
    ...["a", "b", "join"].map((id): WorkflowNode => ({
      id,
      type: "action",
      position: { x: 0, y: 0 },
      data: { type: "action", label: id, config: { actionType: "count" } },
    })),
  ];
  const edges = [
    {
      id: "entry-a",
      source: "lifecycle_1",
      target: "a",
      sourceHandle: "started",
    },
    {
      id: "entry-b",
      source: "lifecycle_1",
      target: "b",
      sourceHandle: "started",
    },
    { id: "a-join", source: "a", target: "join" },
    { id: "b-join", source: "b", target: "join" },
  ];
  const traversal = new Traversal(nodes, edges);
  traversal.markReadyForDownstream("a");
  traversal.markReadyForDownstream("b");
  const runtime = createInMemoryWorkflowRuntime();
  const store = createRecordingWorkflowStore();
  const cancelBoundary = new CancelBoundary({
    lifecycleNodes: [lifecycleNode()],
    edges,
    traversal,
    runtime,
    store,
    executionId: "execution",
    routesCancellation: true,
  });
  const firstFinished = Promise.withResolvers<void>();
  let resolutions = 0;
  let executions = 0;
  const scheduler = new NodeScheduler({
    traversal,
    cancelBoundary,
    runtime,
    store,
    actions: {
      ...noWorkflowActions,
      stepFor: () => () =>
        Effect.sync(() => {
          executions++;
          return { success: true as const, data: { executions } };
        }),
    },
    entities: {
      resolveNode: () =>
        Effect.promise(async () => {
          resolutions++;
          if (resolutions === 1) {
            // Let both scheduling calls reach asynchronous admission. In the
            // broken ordering, the second admission finishes after the first node.
            await new Promise<void>((resolve) => setImmediate(resolve));
          } else {
            await firstFinished.promise;
          }
          return { decision: { outcome: "eligible" as const }, values: {} };
        }),
    },
    executionId: "execution",
    workflowId: "workflow",
    workflowVersionId: "version",
    workflowRunId: "run",
    runMode: "live",
    startPayload: {},
    startEventName: null,
    catalogFingerprint: "",
    entityEligibility: {
      entityType: "subject",
      entityId: "subject",
      condition: "true",
      conditionId: "condition",
    },
  });
  const first = Effect.runPromise(scheduler.runAll(["join"])).finally(() =>
    firstFinished.resolve()
  );
  const second = Effect.runPromise(scheduler.runAll(["join"]));
  await Promise.all([first, second]);
  expect(resolutions).toBe(1);
  expect(executions).toBe(1);
});
