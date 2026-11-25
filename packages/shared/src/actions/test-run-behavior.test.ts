import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import { stepTestRunBehavior } from "#src/actions/test-run-behavior";
import type { ExtensionCatalog } from "#src/extensions/catalog";
import type { WorkflowNode } from "#src/graph/types";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [],
  integrations: [],
  actions: [
    {
      id: "sms/send",
      label: "Send SMS",
      description: "",
      category: "SMS",
      configFields: [
        {
          key: "testBehavior",
          label: "In test runs",
          type: "select",
          defaultValue: "log_only",
          options: [
            { value: "log_only", label: "Log only (do nothing)" },
            { value: "send_to_test_phone", label: "Send to test phone" },
          ],
        },
        {
          key: "testPhoneTo",
          label: "Test Phone Number",
          type: "text",
          showWhen: { field: "testBehavior", equals: "send_to_test_phone" },
        },
      ],
      outputFields: [],
    },
    {
      id: "app/notify",
      label: "Notify",
      description: "",
      category: "App",
      configFields: [],
      outputFields: [],
    },
  ],
};

function step(config: Record<string, unknown>): WorkflowNode {
  return {
    id: "step",
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: "Step", type: "action", config },
  };
}

describe("stepTestRunBehavior", () => {
  it("follows the In test runs option a step holds, or the field's default", () => {
    expect(
      stepTestRunBehavior(step({ actionType: "sms/send" }), catalog)
    ).toEqual({
      kind: "setting",
      settingLabel: "In test runs",
      optionLabel: "Log only (do nothing)",
      skips: true,
      shownFields: [],
    });
    expect(
      stepTestRunBehavior(
        step({
          actionType: "sms/send",
          testBehavior: "send_to_test_phone",
          testPhoneTo: "+15557654321",
        }),
        catalog
      )
    ).toEqual({
      kind: "setting",
      settingLabel: "In test runs",
      optionLabel: "Send to test phone",
      skips: false,
      shownFields: [{ label: "Test Phone Number", value: '"+15557654321"' }],
    });
  });

  it("leaves an action with no setting to its handler, and a built-in step to the engine", () => {
    expect(
      stepTestRunBehavior(step({ actionType: "app/notify" }), catalog)
    ).toEqual({ kind: "handler-decides" });
    expect(
      stepTestRunBehavior(
        step({ actionType: BUILT_IN_ACTION_IDS.wait }),
        catalog
      )
    ).toEqual({ kind: "built-in" });
    expect(stepTestRunBehavior(step({}), catalog)).toBeUndefined();
  });
});
