import { describe, expect, it } from "vitest";
import { actionNodeDisplayTitle } from "#src/components/workflow/nodes/action-node";
import { COMPARISON_NODE_ANNOTATION } from "#src/lib/workflow-graph-types";

describe("actionNodeDisplayTitle", () => {
  it("hides an unavailable action id while rendering a comparison", () => {
    const data = {
      label: "",
      type: "action" as const,
      config: { actionType: "private/internal-action" },
      [COMPARISON_NODE_ANNOTATION]: { kind: "removed" as const },
    };
    const catalog = { actions: [], entities: [], events: [], integrations: [] };

    expect(actionNodeDisplayTitle(data, catalog)).toBe("Unavailable action");
    expect(
      actionNodeDisplayTitle(
        { ...data, [COMPARISON_NODE_ANNOTATION]: undefined },
        catalog
      )
    ).toBe("private/internal-action");
  });
});
