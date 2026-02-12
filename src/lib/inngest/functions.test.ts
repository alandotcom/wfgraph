import { describe, expect, it } from "vitest";
import { CURRENT_WORKFLOW_NAME } from "@/lib/workflow-constants";
import { buildWorkflowFunctions } from "./functions";

describe("buildWorkflowFunctions", () => {
  it("creates one function per workflow with stable IDs", () => {
    const functions = buildWorkflowFunctions([
      {
        id: "workflow_123",
        name: "Order Updates",
      },
      {
        id: "workflow_999",
        name: CURRENT_WORKFLOW_NAME,
      },
    ]);

    expect(functions).toHaveLength(1);
    expect(functions[0].id()).toBe("workflow-workflow_123");
    expect(functions[0].name).toBe("Order Updates");
  });
});
