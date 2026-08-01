import { describe, expect, it } from "vitest";
import {
  getConditionBranchDisplayLabel,
  isConditionActionType,
  normalizeConditionBranch,
} from "#src/conditions/condition-branch";

describe("condition-branch helpers", () => {
  it("reads the two branch handles and nothing else", () => {
    expect(normalizeConditionBranch("true")).toBe("true");
    expect(normalizeConditionBranch("false")).toBe("false");
    expect(normalizeConditionBranch("FALSE")).toBeNull();
    expect(normalizeConditionBranch("branch-true")).toBeNull();
  });

  it("builds user-facing labels from branch handles", () => {
    expect(getConditionBranchDisplayLabel("true")).toBe("True");
    expect(getConditionBranchDisplayLabel("false")).toBe("False");
    expect(getConditionBranchDisplayLabel("other")).toBeNull();
  });

  it("detects the condition action type exactly, as the engine dispatches on it", () => {
    expect(isConditionActionType("Condition")).toBe(true);
    expect(isConditionActionType(" condition ")).toBe(false);
    expect(isConditionActionType("CONDITION")).toBe(false);
    expect(isConditionActionType("twilio/send-sms")).toBe(false);
  });
});
