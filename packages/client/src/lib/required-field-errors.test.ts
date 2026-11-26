import { createStore } from "jotai";
import { describe, expect, it } from "vitest";
import {
  lifecycleCheckFieldKey,
  requiredFieldKey,
  revealedRequiredFieldsAtom,
  revealRefusedFieldsAtom,
} from "#src/lib/required-field-errors";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";

describe("revealRefusedFieldsAtom", () => {
  // The Start's rule builders wait the way an empty required field does, so a
  // refused Publish has to reveal the rule its check reads as well.
  it("reveals the rule a refused Lifecycle Rules check reads", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "wf_1");

    store.set(revealRefusedFieldsAtom, [
      {
        kind: "invalid_lifecycle_rules",
        severity: "blocking",
        nodeId: "start",
        nodeLabel: "Reminders",
        check: "start_filter",
        message: "unfinished",
      },
      {
        kind: "missing_required_field",
        severity: "blocking",
        nodeId: "notify",
        nodeLabel: "Notify",
        fieldKey: "to",
        fieldLabel: "To",
        message: "To is required",
      },
    ]);

    const revealed = store.get(revealedRequiredFieldsAtom);
    expect(
      revealed.has(
        requiredFieldKey("start", lifecycleCheckFieldKey("start_filter"))
      )
    ).toBe(true);
    expect(revealed.has(requiredFieldKey("notify", "to"))).toBe(true);
  });
});
