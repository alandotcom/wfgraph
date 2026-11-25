import { describe, expect, it } from "vitest";
import { firstStepOfGroup } from "#src/lib/workflow-graph-structure";

const graph = {
  nodes: [
    { id: "life", data: { type: "lifecycle" } },
    { id: "outreach", data: { type: "group" } },
    { id: "later", parentId: "outreach", data: { type: "action" } },
    { id: "welcome", parentId: "outreach", data: { type: "action" } },
    { id: "route", data: { type: "action" } },
  ],
  edges: [],
};

describe("firstStepOfGroup", () => {
  it("lands an older Group link on the member with the lowest step number", () => {
    expect(
      firstStepOfGroup({
        graph,
        groupId: "outreach",
        stepNumbers: new Map([
          ["later", 3],
          ["welcome", 2],
        ]),
      })
    ).toBe("welcome");
  });

  it("lands on the first member listed when no member is numbered", () => {
    expect(
      firstStepOfGroup({ graph, groupId: "outreach", stepNumbers: new Map() })
    ).toBe("later");
  });

  it("answers null for a Group the graph does not hold, or a step that is no Group", () => {
    expect(
      firstStepOfGroup({ graph, groupId: "gone", stepNumbers: new Map() })
    ).toBeNull();
    expect(
      firstStepOfGroup({ graph, groupId: "route", stepNumbers: new Map() })
    ).toBeNull();
  });
});
