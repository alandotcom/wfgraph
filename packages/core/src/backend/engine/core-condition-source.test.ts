/**
 * A Condition rule that names its source node reads that node's output, even
 * where a later node offers the same path. A rule naming no node reads the
 * namespace every finished output is folded into, where the later node wins,
 * because published versions written that way must keep routing as they did.
 *
 * The graph is the one the shared-path hazard was found on: the Start Event
 * carries `score: 90` and a scoring step answers `score: 10`.
 */

import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  compileConditionModel,
  type ConditionModel,
  nodeOutputConditionPath,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { readJsonObjectLeniently } from "@wfgraph/shared/types/json";
import type { WorkflowActions } from "#src/backend/engine/actions";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { executeTestWorkflow } from "#src/backend/engine/test-execution";
import { driveWithReplay } from "#src/backend/engine/testing/replay-runtime";
import {
  createLifecycleNode,
  createWaitNode,
} from "#src/backend/engine/testing/wait-fixtures";

function actionNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: id, type: "action", config: { actionType: "test/step" } },
  };
}

/**
 * Every action records the node it ran for inside `step.run`, so a replay
 * answers it from the memo and records nothing. The scoring step answers
 * `score: 10`, and every other step answers `{ sent: true }`.
 */
function recordingActions(ran: string[]): WorkflowActions {
  return {
    stepFor: () => (input, steps) =>
      Effect.promise(async () => {
        const nodeId = String(readJsonObjectLeniently(input._context)?.nodeId);
        const work = () => {
          ran.push(nodeId);
          return Promise.resolve(
            nodeId === "score_step" ? { score: 10 } : { sent: true }
          );
        };
        const data = steps ? await steps.run("work", work) : await work();
        return { success: true as const, data };
      }),
    metadataFor: () => ({
      label: "Step",
      literalConfigKeys: [],
      templateJsonConfigShapes: [],
    }),
    catalogFingerprint: () => "catalog",
  };
}

function scoreAtLeast80(field: string): {
  conditionModel: string;
  condition: string;
} {
  const model: ConditionModel = {
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group",
        logic: "and",
        conditions: [
          {
            id: "rule",
            field,
            fieldType: "number",
            operator: "greater_or_equal",
            value: 80,
          },
        ],
      },
    ],
  };
  const compiled = compileConditionModel(model);
  if (!compiled.valid) {
    throw new Error(compiled.error);
  }
  return {
    conditionModel: serializeConditionModel(model),
    condition: compiled.expression,
  };
}

/**
 * Lifecycle -> score step -> Condition -> true: high -> Wait 1h -> follow-up,
 * false: low. The Wait parks the high branch, so a second pass replays the
 * Condition from its memo.
 */
function graphTesting(field: string) {
  return createSerializedWorkflowGraph({
    nodes: [
      createLifecycleNode("lifecycle_1"),
      actionNode("score_step"),
      {
        id: "condition_1",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Score at least 80",
          type: "action",
          config: { actionType: "Condition", ...scoreAtLeast80(field) },
        },
      },
      actionNode("high"),
      createWaitNode("wait_1", { waitMode: "delay", waitDuration: "1h" }),
      actionNode("follow_up"),
      actionNode("low"),
    ],
    edges: [
      {
        id: "edge_score",
        source: "lifecycle_1",
        sourceHandle: "started",
        target: "score_step",
      },
      { id: "edge_condition", source: "score_step", target: "condition_1" },
      {
        id: "edge_true",
        source: "condition_1",
        sourceHandle: "true",
        target: "high",
      },
      {
        id: "edge_false",
        source: "condition_1",
        sourceHandle: "false",
        target: "low",
      },
      { id: "edge_wait", source: "high", target: "wait_1" },
      { id: "edge_follow_up", source: "wait_1", target: "follow_up" },
    ],
  });
}

async function runWith(field: string) {
  const store = createRecordingWorkflowStore();
  const ran: string[] = [];
  const run = await driveWithReplay(
    (runtime) =>
      executeTestWorkflow(
        {
          graph: graphTesting(field),
          executionId: "exec_source",
          workflowId: "workflow_source",
          startPayload: { score: 90 },
        },
        runtime,
        store,
        recordingActions(ran)
      ),
    { waitRows: store }
  );
  return { run, ran };
}

it("reads the Start Event's score for a rule naming the Lifecycle Node, on every pass", async () => {
  const { run, ran } = await runWith(
    nodeOutputConditionPath("lifecycle_1", "score") ?? ""
  );

  // The Wait below the true branch parks the first pass, and the second pass
  // replays the Condition from its memo and takes the same branch.
  expect(run.invocations).toBe(2);
  expect(run.value.status).toBe("completed");
  expect(ran).toEqual(["score_step", "high", "follow_up"]);
  expect(run.value.results.condition_1).toEqual({
    success: true,
    data: { success: true, data: { condition: true } },
  });
});

it("reads the scoring step's score for a rule naming that step", async () => {
  const { run, ran } = await runWith(
    nodeOutputConditionPath("score_step", "score") ?? ""
  );

  expect(run.value.status).toBe("completed");
  expect(ran).toEqual(["score_step", "low"]);
});

it("reads the later node's score for a rule naming no node, as published versions do", async () => {
  const { run, ran } = await runWith("score");

  expect(run.value.status).toBe("completed");
  expect(ran).toEqual(["score_step", "low"]);
});
