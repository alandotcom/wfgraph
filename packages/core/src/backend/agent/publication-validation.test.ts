import { describe, expect, it } from "vitest";
import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { validateAgentPublication } from "#src/backend/agent/publication-validation";

const manualLifecycle: WorkflowNode = {
  id: "entry",
  type: "lifecycle",
  position: { x: 0, y: 0 },
  data: {
    label: "Lifecycle",
    type: "lifecycle",
    config: {
      lifecycleRules: {
        startEvents: [],
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    },
  },
};

describe("validateAgentPublication", () => {
  it("accepts a configured manual workflow", () => {
    expect(
      validateAgentPublication({
        document: { nodes: [manualLifecycle], edges: [] },
        catalog: fixtureCatalog,
        integrations: [],
      })
    ).toEqual({ publishBlockers: [], warnings: [] });
  });

  it("reports canonical Event and unreachable-node failures", () => {
    const unknownEventLifecycle: WorkflowNode = {
      ...manualLifecycle,
      data: {
        ...manualLifecycle.data,
        config: {
          lifecycleRules: {
            startEvents: ["unknown.event"],
            cancelEvents: [],
            concurrency: "unlimited",
            allowManualStart: false,
          },
        },
      },
    };
    const orphan: WorkflowNode = {
      id: "orphan",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Orphan condition",
        type: "action",
        config: { actionType: "Condition" },
      },
    };

    const result = validateAgentPublication({
      document: { nodes: [unknownEventLifecycle, orphan], edges: [] },
      catalog: fixtureCatalog,
      integrations: [],
    });

    expect(result.publishBlockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "invalid_event" }),
        expect.objectContaining({ kind: "unreachable_node" }),
      ])
    );
  });

  it("keeps deleted-node references as warnings", () => {
    const action: WorkflowNode = {
      id: "notify",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Notify recruiting",
        type: "action",
        config: {
          actionType: "slack/send-message",
          integrationId: "slack-primary",
          channel: "#recruiting",
          text: "Score {{@removed:Removed.score}}",
        },
      },
    };

    const result = validateAgentPublication({
      document: { nodes: [manualLifecycle, action], edges: [] },
      catalog: fixtureCatalog,
      integrations: [{ id: "slack-primary", type: "slack" }],
    });

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: "broken_reference" })
    );
  });
});
