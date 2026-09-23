import { expect, it } from "vitest";
import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { validateWorkflowGraph } from "#src/backend/services/workflows/validation/workflow-graph";
import {
  executeTestWorkflow,
  executeTestWorkflowBranch,
} from "#src/backend/engine/test-execution";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { driveWithReplay } from "#src/backend/engine/testing/replay-runtime";
import {
  createLifecycleNode,
  createWaitNode,
  createAfterWaitNode,
} from "#src/backend/engine/testing/wait-fixtures";
import type { WorkflowActions } from "#src/backend/engine/actions";

it.each([false, true])(
  "refreshes inherited outputs after migration (return to original version: %s)",
  async (returnToOriginal) => {
    const source = { ...createAfterWaitNode(), id: "source" };
    const after: WorkflowNode = {
      ...createAfterWaitNode(),
      id: "after",
      data: {
        type: "action",
        label: "After",
        config: {
          actionType: "record",
          subject: "{{@source:Source.condition}}",
        },
      },
    };
    const graph = (migrated: boolean) =>
      createSerializedWorkflowGraph({
        nodes: [
          createLifecycleNode("life"),
          source,
          createWaitNode("wait_1", { waitMode: "delay", waitDuration: "10s" }),
          ...(migrated
            ? []
            : [
                createWaitNode("wait_b", {
                  waitMode: "delay",
                  waitDuration: "1s",
                }),
              ]),
          migrated || returnToOriginal
            ? after
            : {
                ...after,
                data: {
                  ...after.data,
                  config: { actionType: "record", subject: "original" },
                },
              },
        ],
        edges: migrated
          ? [
              {
                id: "ls",
                source: "life",
                target: "source",
                sourceHandle: "started",
              },
              {
                id: "sw",
                source: "source",
                target: "wait_1",
                sourceHandle: "true",
              },
              { id: "wa", source: "wait_1", target: "after" },
            ]
          : [
              {
                id: "lb",
                source: "life",
                target: "wait_b",
                sourceHandle: "started",
              },
              { id: "bs", source: "wait_b", target: "source" },
              {
                id: "lw",
                source: "life",
                target: "wait_1",
                sourceHandle: "started",
              },
              { id: "wa", source: "wait_1", target: "after" },
            ],
      });
    const store = createRecordingWorkflowStore();
    const sourceDone = () => {
      const index = store
        .callsOf("startStepLog")
        .findIndex((call) => call.nodeId === "source");
      return (
        index >= 0 &&
        store
          .callsOf("completeStepLog")
          .some((call) => call.logId === `log_${index + 1}`)
      );
    };
    const actions: WorkflowActions = {
      stepFor: () => (input) =>
        Effect.succeed({ success: true, data: { subject: input.subject } }),
      metadataFor: () => ({
        label: "Record",
        literalConfigKeys: [],
        templateJsonConfigShapes: [],
      }),
      catalogFingerprint: () => "catalog",
    };
    const run = await driveWithReplay(
      (runtime) =>
        executeTestWorkflow(
          { graph: graph(false), executionId: "exec_wait", workflowId: "wf" },
          runtime,
          store,
          actions
        ),
      {
        branch: (runtime, input) => {
          const migrated =
            input.entryNodeId === "wait_1" &&
            sourceDone() &&
            (!returnToOriginal ||
              store.callsOf("reparkWaitState").length === 0);
          return executeTestWorkflowBranch(
            {
              ...input,
              graph: graph(migrated),
              executionId: "exec_wait",
              workflowId: "wf",
              workflowVersionId: migrated ? "new" : "old",
            },
            runtime,
            store,
            actions
          );
        },
      }
    );

    expect(validateWorkflowGraph(graph(false)).valid).toBe(true);
    expect(validateWorkflowGraph(graph(true)).valid).toBe(true);
    expect(run.value.results.after).toMatchObject({
      success: true,
      data: { success: true, data: { subject: "true" } },
    });
    expect(
      store.callsOf("startStepLog").filter((call) => call.nodeId === "source")
    ).toHaveLength(1);
    expect(store.callsOf("readNodeOutputs")).toHaveLength(5);
  }
);
