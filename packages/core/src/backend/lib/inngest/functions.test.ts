import { describe, expect, it } from "vitest";
import { CURRENT_WORKFLOW_NAME } from "#src/backend/lib/workflow-constants";
import { buildWorkflowFunctions } from "./functions";

/**
 * The run functions, which are one per saved workflow and keyed on its id.
 *
 * Nothing here reads a graph. The event listeners are the catalog's, one per
 * Event, and `event-listener-function.test.ts` covers them: which Events exist
 * stopped being a question about saved graphs when the per-workflow listener went.
 */
describe("buildWorkflowFunctions", () => {
  it("creates one function per workflow with stable ids", () => {
    const functions = buildWorkflowFunctions([
      { id: "workflow_123", name: "Order Updates" },
      { id: "workflow_999", name: CURRENT_WORKFLOW_NAME },
    ]);

    expect(functions).toHaveLength(1);
    expect(functions[0].id()).toBe("workflow-workflow_123");
    expect(functions[0].name).toBe("Order Updates");
  });

  // The draft has no run of its own: it is what the editor autosaves into, and
  // nothing starts it.
  it("excludes the editor's draft", () => {
    const functions = buildWorkflowFunctions([
      { id: "workflow_only_current", name: CURRENT_WORKFLOW_NAME },
    ]);

    expect(functions).toHaveLength(0);
  });

  it("handles an empty workflow list", () => {
    expect(buildWorkflowFunctions([])).toHaveLength(0);
  });
});
