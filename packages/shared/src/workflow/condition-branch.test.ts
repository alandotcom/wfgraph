import { describe, expect, it } from "bun:test";
import {
  getConditionBranchDisplayLabel,
  isConditionActionType,
  normalizeConditionBranch,
} from "@/workflow/condition-branch";

describe("condition-branch helpers", () => {
  it("normalizes true/false branch handles", () => {
    expect(normalizeConditionBranch("true")).toBe("true");
    expect(normalizeConditionBranch("FALSE")).toBe("false");
    expect(normalizeConditionBranch("branch-true")).toBe("true");
    expect(normalizeConditionBranch("branch-false")).toBe("false");
  });

  it("builds user-facing labels from branch handles", () => {
    expect(getConditionBranchDisplayLabel("true")).toBe("True");
    expect(getConditionBranchDisplayLabel("false")).toBe("False");
    expect(getConditionBranchDisplayLabel("other")).toBeNull();
  });

  it("detects condition action type with normalized casing", () => {
    expect(isConditionActionType("Condition")).toBe(true);
    expect(isConditionActionType(" condition ")).toBe(true);
    expect(isConditionActionType("CONDITION")).toBe(true);
    expect(isConditionActionType("HTTP Request")).toBe(false);
  });
});
