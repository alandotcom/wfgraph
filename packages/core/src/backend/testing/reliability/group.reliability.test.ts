import { expect } from "vitest";
import { Schema } from "effect";
import { START } from "#src/backend/testing/reliability/fixtures";
import { eventually } from "#src/backend/testing/reliability/control";
import {
  expectSettledExecution,
  nodeLogCounts,
  observeExecution,
  waitForOpenWaits,
} from "#src/backend/testing/reliability/assertions";
import {
  buildGroupScenario,
  groupScenarios,
  type GroupScenario,
} from "#src/backend/testing/reliability/group-scenarios";
import {
  groupMemberIds,
  withGroupLayout,
  type GroupLayout,
} from "#src/backend/testing/reliability/groups";
import type { ReliabilityHost } from "#src/backend/testing/reliability/host";
import { groupLayoutProperty } from "#src/backend/testing/reliability/property";

// Each case runs one generated workflow ungrouped and inside a vertical and a
// horizontal Group, on a fresh host per layout. Every layout must reach the
// outcome derived from the scenario, and the three observations must be equal.
const examples: GroupScenario[] = [
  {
    shape: { kind: "chain", steps: ["record", "event", "delay", "record"] },
    groupPrefix: false,
    groupSuffix: false,
    fault: "settlement",
  },
  {
    shape: {
      kind: "fanout",
      branches: [
        { waits: true, wakeRank: 2 },
        { waits: false, wakeRank: 0 },
        { waits: true, wakeRank: 1 },
      ],
      sharedWake: false,
    },
    groupPrefix: true,
    groupSuffix: false,
    fault: "completion",
  },
  // Sibling Waits inside the Group listen for the same Event. One delivery
  // releases both, and each branch's record runs once with that payload.
  {
    shape: {
      kind: "fanout",
      branches: [
        { waits: true, wakeRank: 0 },
        { waits: true, wakeRank: 0 },
        { waits: false, wakeRank: 0 },
      ],
      sharedWake: true,
    },
    groupPrefix: false,
    groupSuffix: false,
    fault: "settlement",
  },
  // Parallel members continue to one shared step outside the Group, which is
  // one continuation. The step runs once, after both branches, with both
  // branch outputs.
  {
    shape: { kind: "sharedContinuation", branchCount: 2 },
    groupPrefix: true,
    groupSuffix: false,
    fault: "completion",
  },
  {
    shape: {
      kind: "condition",
      takesTrue: false,
      continueFrom: "branch",
      closedPathLength: 2,
    },
    groupPrefix: false,
    groupSuffix: false,
    fault: "none",
  },
  {
    shape: {
      kind: "condition",
      takesTrue: true,
      continueFrom: "step",
      closedPathLength: 1,
    },
    groupPrefix: true,
    groupSuffix: true,
    fault: "completion",
  },
  {
    shape: { kind: "join", waitBeforeSplit: "event", armLengths: [2, 1] },
    groupPrefix: false,
    groupSuffix: true,
    fault: "settlement",
  },
];

const readBack = Schema.Struct({
  json: Schema.Struct({
    hasUnpublishedChanges: Schema.Boolean,
    graph: Schema.Struct({
      nodes: Schema.Array(
        Schema.Struct({
          key: Schema.String,
          attributes: Schema.Struct({
            parentId: Schema.optionalKey(Schema.String),
          }),
        })
      ),
    }),
  }),
});

async function publishLayout(
  host: ReliabilityHost,
  graph: ReturnType<typeof withGroupLayout>
) {
  // Publish runs the real Group contract, so an invalid Group fails here too.
  const workflowId = await host.publish(graph);
  const stored = Schema.decodeUnknownSync(readBack)(
    await host.rpc("getById", { workflowId })
  );
  expect(stored.json.hasUnpublishedChanges).toBe(false);
  const storedMembers = stored.json.graph.nodes
    .filter((item) => item.attributes.parentId !== undefined)
    .map((item) => item.key)
    .toSorted();
  expect(storedMembers).toEqual(groupMemberIds(graph));
  return workflowId;
}

groupLayoutProperty(
  "Group layout leaves execution unchanged",
  groupScenarios,
  examples,
  async (host, scenario, layout: GroupLayout) => {
    const built = buildGroupScenario(scenario);
    const graph = withGroupLayout(built.graph, built.memberIds, layout);
    const workflowId = await publishLayout(host, graph);

    if (built.fault !== "none")
      host.faults[built.fault].arm({ fail: true, hold: false });
    await host.runtime.send(START, {
      entityId: "subject",
      marker: built.startMarker,
    });
    const executions = await eventually(
      "Execution admitted",
      () =>
        host.run(
          host.repo.listByWorkflow({ workflowId, includeSuperseded: true })
        ),
      (rows) => rows.length === 1
    );
    const executionId = executions[0]!.id;

    // Each wake Event releases the open Waits subscribed to it. The other open
    // Waits must stay parked, and only the steps upstream of an open Wait may
    // have run.
    const checkpoints: Array<{ openWaits: string[]; sideEffects: string[] }> =
      [];
    for (const stage of built.stages) {
      await waitForOpenWaits(host, executionId, stage.openWaits);
      const sideEffects = await eventually(
        `side effects before waking [${stage.openWaits.join(", ")}]`,
        async () => host.ledger.map((entry) => entry.marker).toSorted(),
        (markers) => markers.length >= stage.sideEffectsBefore.length
      );
      expect(sideEffects).toEqual(stage.sideEffectsBefore.toSorted());
      checkpoints.push({ openWaits: stage.openWaits, sideEffects });
      await host.runtime.send(stage.wake.event, {
        entityId: "subject",
        marker: stage.wake.marker,
      });
    }

    await expectSettledExecution(host, workflowId, "completed");
    const observation = await observeExecution(host, executionId);
    expect(observation.status).toBe("completed");
    expect(observation.sideEffects).toEqual(built.expectedSideEffects);
    expect(nodeLogCounts(observation)).toEqual(
      Object.fromEntries(built.expectedLoggedNodeIds.map((id) => [id, 1]))
    );
    expect(
      observation.nodeLogs.filter((entry) => entry.status !== "success")
    ).toEqual([]);
    if (built.fault !== "none") expect(host.faults[built.fault].hits).toBe(1);
    return { observation, checkpoints };
  },
  { runsVariable: "WFGRAPH_RELIABILITY_GROUP_RUNS", defaultRuns: 3 }
);
