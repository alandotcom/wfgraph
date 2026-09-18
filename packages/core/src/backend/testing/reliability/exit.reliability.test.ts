import { expect } from "vitest";
import * as fc from "fast-check";
import {
  lifecycle,
  record,
  edge,
  wait,
  START,
  WAKE,
} from "#src/backend/testing/reliability/fixtures";
import { eventually } from "#src/backend/testing/reliability/control";
import {
  waitForRegisteredWaits,
  expectSettledExecution,
  observeExecution,
} from "#src/backend/testing/reliability/assertions";
import { withGroupLayout } from "#src/backend/testing/reliability/groups";
import { groupLayoutProperty } from "#src/backend/testing/reliability/property";

// Started fans out into 2–3 branches, each with a Wait followed by an action.
// Once every branch is waiting, make the Entity ineligible or missing and wake one.
// Exit must release all sibling waits without running branch actions or Cancel cleanup.
// Each case also runs with the branches in a vertical and a horizontal Group, which
// holds every branch or only one, and must exit the same way.
const exitScenarios = fc.record({
  branchCount: fc.integer({ min: 2, max: 3 }),
  eventBranchChoice: fc.nat(2),
  siblingsUseDelay: fc.boolean(),
  entityDisappears: fc.boolean(),
  reverseBranchOrder: fc.boolean(),
  groupedBranches: fc.constantFrom<"all" | "woken" | "sibling">(
    "all",
    "woken",
    "sibling"
  ),
});
groupLayoutProperty(
  "Entity Exit releases parked siblings",
  exitScenarios,
  [
    {
      branchCount: 2,
      eventBranchChoice: 0,
      siblingsUseDelay: false,
      entityDisappears: false,
      reverseBranchOrder: false,
      groupedBranches: "all",
    },
    {
      branchCount: 3,
      eventBranchChoice: 1,
      siblingsUseDelay: true,
      entityDisappears: true,
      reverseBranchOrder: true,
      groupedBranches: "sibling",
    },
  ],
  async (host, scenario, layout) => {
    // Keep the chosen branch valid when fast-check shrinks the branch count.
    const branchToWake = scenario.eventBranchChoice % scenario.branchCount;
    const branchIds = Array.from(
      { length: scenario.branchCount },
      (_, index) => index
    );
    if (scenario.reverseBranchOrder) branchIds.reverse();
    const sibling = (branchToWake + 1) % scenario.branchCount;
    const groupedIds =
      scenario.groupedBranches === "all"
        ? branchIds
        : [scenario.groupedBranches === "woken" ? branchToWake : sibling];
    const workflowId = await host.publish(
      withGroupLayout(
        parallelWaitWorkflow(
          branchIds,
          branchToWake,
          scenario.siblingsUseDelay
        ),
        groupedIds.flatMap((index) => [`wait_${index}`, `after_${index}`]),
        layout
      )
    );

    // Wait for both the database rows and Inngest's registered waits or sleeps.
    await host.runtime.send(START, { entityId: "subject", marker: "start" });
    const executions = await eventually(
      "Execution admitted",
      () =>
        host.run(
          host.repo.listByWorkflow({ workflowId, includeSuperseded: true })
        ),
      (rows) => rows.length === 1
    );
    const executionId = executions[0]!.id;
    const parked = await waitForRegisteredWaits(
      host,
      executionId,
      scenario.branchCount
    );

    expect(parked.map((row) => row.nodeId).toSorted()).toEqual(
      branchIds.map((index) => `wait_${index}`).toSorted()
    );

    // Only one branch receives a wake event. The other waits have ten-minute timeouts.
    if (scenario.entityDisappears) host.state.missing = true;
    else host.state.active = false;
    await host.runtime.send(WAKE[branchToWake]!, {
      entityId: "subject",
      marker: "exit",
    });

    // The Execution must exit within 30 seconds, well before sibling timeouts.
    await expectSettledExecution(host, workflowId, "exited");
    // No post-Wait action and no Canceled-outlet cleanup may run after Exit.
    expect(host.ledger).toEqual([]);
    return observeExecution(host, executionId);
  }
);

function parallelWaitWorkflow(
  branchIds: number[],
  branchToWake: number,
  siblingsUseDelay: boolean
) {
  return {
    nodes: [
      lifecycle(["before-execution", "before-node"]),
      ...branchIds.flatMap((index) => [
        wait(
          `wait_${index}`,
          index !== branchToWake && siblingsUseDelay ? "delay" : "event",
          WAKE[index]
        ),
        record(`after_${index}`),
      ]),
      record("cleanup"),
    ],
    edges: [
      ...branchIds.flatMap((index) => [
        edge("entry", `wait_${index}`, "started"),
        edge(`wait_${index}`, `after_${index}`),
      ]),
      edge("entry", "cleanup", "canceled"),
    ],
  };
}
