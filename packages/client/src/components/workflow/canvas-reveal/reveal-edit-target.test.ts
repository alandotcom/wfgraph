import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { editFocusTarget, newStepFocusTarget } from "./reveal-edit-target";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [],
  integrations: [],
  actions: [
    {
      id: "notices/send-letter",
      label: "Send letter",
      description: "Send one letter",
      category: "Notices",
      configFields: [
        { key: "subject", label: "Subject", type: "template-input" },
        {
          key: "body",
          label: "Body",
          type: "template-textarea",
          required: true,
        },
      ],
      outputFields: [],
    },
  ],
};

function step(
  config: Record<string, unknown>,
  type: WorkflowNode["data"]["type"] = "action"
): WorkflowNode {
  return {
    id: "step",
    type,
    position: { x: 0, y: 0 },
    data: { label: "Step", type, config },
  };
}

describe("editFocusTarget", () => {
  it("focuses the action picker of a step with no action, and the label otherwise", () => {
    expect(editFocusTarget(step({}))).toBe("action-filter");
    expect(editFocusTarget(step({ actionType: "notices/send-letter" }))).toBe(
      "label"
    );
    expect(editFocusTarget(step({}, "lifecycle"))).toBe("label");
    expect(editFocusTarget(step({}, "group"))).toBe("label");
  });

  it("names no field for an Event Split, which has none", () => {
    expect(
      editFocusTarget(step({ actionType: BUILT_IN_ACTION_IDS.eventSplit }))
    ).toBeNull();
  });
});

describe("newStepFocusTarget", () => {
  it("focuses the first required field a new step leaves empty", () => {
    expect(
      newStepFocusTarget(step({ actionType: "notices/send-letter" }), catalog)
    ).toBe("body");
  });

  it("focuses the label once every required field holds a value", () => {
    expect(
      newStepFocusTarget(
        step({ actionType: "notices/send-letter", body: "Hello" }),
        catalog
      )
    ).toBe("label");
  });

  it("focuses a new Wait's duration and a new Condition's rule builder", () => {
    expect(
      newStepFocusTarget(
        step({ actionType: BUILT_IN_ACTION_IDS.wait, waitMode: "delay" }),
        catalog
      )
    ).toBe("waitDuration");
    expect(
      newStepFocusTarget(
        step({ actionType: BUILT_IN_ACTION_IDS.condition }),
        catalog
      )
    ).toBe("condition");
  });

  it("focuses the action picker of a step with no action", () => {
    expect(newStepFocusTarget(step({}), catalog)).toBe("action-filter");
  });
});
