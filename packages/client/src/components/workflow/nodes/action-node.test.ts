import { describe, expect, it } from "vitest";
import {
  actionNodeDisplayTitle,
  groupedActionNodeClassName,
} from "#src/components/workflow/nodes/action-node";
import { COMPARISON_NODE_ANNOTATION } from "#src/lib/workflow-graph-types";

describe("groupedActionNodeClassName", () => {
  it("permits pointer dragging for a removed comparison member only", () => {
    expect(groupedActionNodeClassName({ kind: "removed" }, true)).not.toContain(
      "nodrag"
    );
    expect(groupedActionNodeClassName({ kind: "added" }, true)).toContain(
      "nodrag"
    );
    expect(groupedActionNodeClassName(undefined, true)).toContain("nodrag");
  });
});

describe("actionNodeDisplayTitle", () => {
  it("hides an unavailable action id while rendering a comparison", () => {
    const data = {
      label: "",
      type: "action" as const,
      config: { actionType: "private/internal-action" },
      [COMPARISON_NODE_ANNOTATION]: { kind: "removed" as const },
    };
    const catalog = { actions: [], events: [], integrations: [] };

    expect(actionNodeDisplayTitle(data, catalog)).toBe("Unavailable action");
    expect(
      actionNodeDisplayTitle(
        { ...data, [COMPARISON_NODE_ANNOTATION]: undefined },
        catalog
      )
    ).toBe("private/internal-action");
  });
});
