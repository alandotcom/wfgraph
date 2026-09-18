import * as fc from "fast-check";
import { expect, test } from "vitest";
import {
  buildGroupScenario,
  groupScenarios,
} from "#src/backend/testing/reliability/group-scenarios";
import {
  GROUP_FRAME_ID,
  GROUP_LAYOUTS,
  groupMemberIds,
  withGroupLayout,
} from "#src/backend/testing/reliability/groups";
import {
  edge,
  lifecycle,
  record,
} from "#src/backend/testing/reliability/fixtures";

test("every generated Group is one the editor forms and Publish accepts", () => {
  fc.assert(
    fc.property(groupScenarios, (scenario) => {
      const built = buildGroupScenario(scenario);
      for (const layout of GROUP_LAYOUTS) {
        // Throws with the refusal when the generated Group breaks a rule.
        const graph = withGroupLayout(built.graph, built.memberIds, layout);
        expect(graph.edges).toEqual(built.graph.edges);
        expect(
          graph.nodes
            .filter((item) => item.key !== GROUP_FRAME_ID)
            .map((item) => item.attributes.data)
        ).toEqual(built.graph.nodes.map((item) => item.attributes.data));
        expect(groupMemberIds(graph)).toEqual(
          layout === "ungrouped" ? [] : built.memberIds.toSorted()
        );
      }
    }),
    { numRuns: 300 }
  );
});

test("a Group entered from two outside outlets is refused before publication", () => {
  const graph = {
    nodes: [lifecycle([]), record("left"), record("right")],
    edges: [
      edge("entry", "left", "started"),
      edge("entry", "right", "canceled"),
    ],
  };
  expect(() => withGroupLayout(graph, ["left", "right"], "ungrouped")).toThrow(
    /Invalid generated Group over left, right/
  );
});

test("sibling Waits on one shared wake Event are released by a single delivery", () => {
  const built = buildGroupScenario({
    shape: {
      kind: "fanout",
      branches: [
        { waits: true, wakeRank: 1 },
        { waits: true, wakeRank: 0 },
      ],
      sharedWake: true,
    },
    groupPrefix: false,
    groupSuffix: false,
    fault: "none",
  });
  expect(built.stages).toEqual([
    {
      openWaits: ["fan_wait_1", "fan_wait_0"],
      sideEffectsBefore: ["prefix:go"],
      wake: { event: "reliability/wake0", marker: "wake:fan" },
    },
  ]);
  expect(built.expectedSideEffects).toEqual([
    "fan_0<prefix:go+wake:fan",
    "fan_1<prefix:go+wake:fan",
    "prefix:go",
  ]);
});
