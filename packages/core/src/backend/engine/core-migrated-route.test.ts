import { expect, it } from "vitest";
import { Effect } from "effect";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";
import { validateWorkflowGraph } from "#src/backend/services/workflows/validation/workflow-graph";
import { Traversal } from "#src/backend/engine/traversal";
import { stubExecutionRepo } from "#src/backend/lib/effect/test-layers";
import { classifyMigrationCandidates } from "#src/backend/services/workflows/migration/classify";
import {
  createAfterWaitNode,
  createLifecycleNode,
  createWaitNode,
} from "#src/backend/engine/testing/wait-fixtures";

it.each([{ outlet: "false" }, { outlet: "true" }])(
  "classifies a parked run whose completed route a Migration rewires to $outlet as eligible",
  async ({ outlet }) => {
    const condition = (id: string) => ({ ...createAfterWaitNode(), id });
    const oldGraph = createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("life"),
        createWaitNode("wait", { waitMode: "delay", waitDuration: "1s" }),
        condition("condition_1"),
        condition("condition_2"),
        condition("branch"),
        condition("join"),
      ],
      edges: [
        {
          id: "old-wait",
          source: "life",
          target: "wait",
          sourceHandle: "started",
        },
        {
          id: "old-c1",
          source: "life",
          target: "condition_1",
          sourceHandle: "started",
        },
        {
          id: "old-c2",
          source: "life",
          target: "condition_2",
          sourceHandle: "started",
        },
        {
          id: "old-c1-join",
          source: "condition_1",
          target: "join",
          sourceHandle: "true",
        },
        {
          id: "old-c2-branch",
          source: "condition_2",
          target: "branch",
          sourceHandle: "false",
        },
        {
          id: "old-branch-join",
          source: "branch",
          target: "join",
          sourceHandle: "true",
        },
      ],
    });
    const newGraph = createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("life"),
        createWaitNode("wait", { waitMode: "delay", waitDuration: "1s" }),
        condition("condition_1"),
        condition("branch"),
        condition("join"),
      ],
      edges: [
        {
          id: "new-wait",
          source: "life",
          target: "wait",
          sourceHandle: "started",
        },
        { id: "new-wait-c1", source: "wait", target: "condition_1" },
        { id: "new-wait-branch", source: "wait", target: "branch" },
        {
          id: "new-c1-join",
          source: "condition_1",
          target: "join",
          sourceHandle: outlet,
        },
        {
          id: "new-branch-join",
          source: "branch",
          target: "join",
          sourceHandle: "true",
        },
      ],
    });
    expect(validateWorkflowGraph(oldGraph).valid).toBe(true);
    expect(validateWorkflowGraph(newGraph).valid).toBe(true);
    const oldGraphData = toWorkflowGraphData(oldGraph);
    const oldTraversal = new Traversal(oldGraphData.nodes, oldGraphData.edges);
    oldTraversal.markReadyForDownstream("life", {
      kind: "outlet",
      outlet: "started",
    });
    oldTraversal.markCompleted("condition_1", {
      success: true,
      data: { condition: true },
    });
    oldTraversal.markReadyForDownstream("condition_1", {
      kind: "condition",
      branch: "true",
    });
    oldTraversal.markCompleted("condition_2", {
      success: true,
      data: { condition: true },
    });
    oldTraversal.markReadyForDownstream("condition_2", {
      kind: "condition",
      branch: "true",
    });
    expect(oldTraversal.isReadyToRun("join")).toBe(false);
    expect(oldTraversal.isReadyToRun("wait")).toBe(true);

    const waitState = {
      id: "wait-row",
      workflowId: "wf",
      executionId: "exec",
      nodeId: "wait",
      nodeName: "Wait",
      waitType: "delay" as const,
      status: "waiting" as const,
      resumeToken: null,
      waitUntil: new Date(Date.now() + 86_400_000),
      subscribedEvents: [],
      metadata: null,
      createdAt: new Date(Date.now() - 60_000),
      resumedAt: null,
      cancelledAt: null,
    };
    const loggedNodes = new Map([
      ["exec", new Set(["life", "condition_1", "condition_2", "wait"])],
    ]);
    const classification = await Effect.runPromise(
      classifyMigrationCandidates({
        candidates: [
          {
            id: "exec",
            status: "waiting",
            workflowVersionId: "old",
            versionKind: "published",
            versionNumber: 1,
            entityType: null,
            entityId: null,
          },
        ],
        targetVersion: {
          id: "new",
          workflowId: "wf",
          version: 2,
          kind: "published",
          graph: newGraph,
          catalogFingerprint: "catalog",
          graphDigest: "digest",
          publishedAt: new Date(),
          lastPinnedAt: null,
        },
      }).pipe(
        Effect.provide(
          stubExecutionRepo({
            listWaitingStatesForExecutions: () =>
              Effect.succeed(new Map([["exec", [waitState]]])),
            listLoggedNodeIdsForExecutions: () => Effect.succeed(loggedNodes),
          })
        )
      )
    );

    expect(classification[0]?.kind).toBe("eligible");
  }
);
