import { describe, expect, it } from "vitest";
import type { ExtensionCatalog } from "#src/extensions/catalog";
import type { WorkflowNode } from "#src/graph/types";
import {
  collectWorkflowIssues,
  findUnconfiguredIntegrationNodes,
  groupWorkflowIssuesForOverlay,
  hasBlockingWorkflowIssues,
} from "#src/graph/workflow-issues";

const catalog: ExtensionCatalog = {
  events: [],
  actions: [
    {
      id: "custom/send",
      label: "Send Message",
      description: "Sends a message",
      category: "Custom",
      integration: "slack",
      configFields: [
        { key: "channel", label: "Channel", type: "text", required: true },
        { key: "message", label: "Message", type: "template-input" },
      ],
      outputFields: [],
    },
    {
      id: "Condition",
      label: "Condition",
      description: "Branches",
      category: "Logic",
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [
    {
      type: "slack",
      label: "Slack",
      description: "Slack workspace",
      credentialFields: {},
      hasTest: false,
    },
  ],
};

function actionNode(
  id: string,
  config: Record<string, unknown>,
  label = "Action"
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label,
      type: "action",
      config,
    },
  };
}

describe("collectWorkflowIssues", () => {
  it("reports missing required fields as blocking", () => {
    const issues = collectWorkflowIssues({
      nodes: [actionNode("a1", { actionType: "custom/send" }, "Notify")],
      catalog,
      integrations: [{ id: "int_1", type: "slack" }],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "missing_required_field",
          severity: "blocking",
          nodeId: "a1",
          fieldKey: "channel",
        }),
      ])
    );
    expect(hasBlockingWorkflowIssues(issues)).toBe(true);
  });

  it("reports a missing connection as blocking", () => {
    const issues = collectWorkflowIssues({
      nodes: [
        actionNode(
          "a1",
          { actionType: "custom/send", channel: "#general" },
          "Notify"
        ),
      ],
      catalog,
      integrations: [],
    });

    expect(issues).toContainEqual(
      expect.objectContaining({
        kind: "missing_integration",
        severity: "blocking",
        integrationType: "slack",
        nodeLabel: "Notify",
      })
    );
  });

  it("treats an unknown integration id as missing", () => {
    const issues = collectWorkflowIssues({
      nodes: [
        actionNode(
          "a1",
          {
            actionType: "custom/send",
            channel: "#general",
            integrationId: "gone",
          },
          "Notify"
        ),
      ],
      catalog,
      integrations: [{ id: "int_1", type: "slack" }],
    });

    expect(
      issues.some(
        (issue) => issue.kind === "missing_integration" && issue.nodeId === "a1"
      )
    ).toBe(true);
  });

  it("reports orphan template refs as warnings", () => {
    const issues = collectWorkflowIssues({
      nodes: [
        actionNode(
          "a1",
          {
            actionType: "custom/send",
            channel: "#general",
            integrationId: "int_1",
            message: "Hi {{@missing:Gone.name}}",
          },
          "Notify"
        ),
      ],
      catalog,
      integrations: [{ id: "int_1", type: "slack" }],
    });

    expect(issues).toEqual([
      expect.objectContaining({
        kind: "broken_reference",
        severity: "warning",
        referencedNodeId: "missing",
        displayText: "Gone.name",
        fieldKey: "message",
      }),
    ]);
    expect(hasBlockingWorkflowIssues(issues)).toBe(false);
  });

  it("groups issues for the overlay", () => {
    const issues = collectWorkflowIssues({
      nodes: [
        actionNode("a1", { actionType: "custom/send" }, "First"),
        actionNode(
          "a2",
          {
            actionType: "custom/send",
            channel: "#x",
            message: "{{@gone:Old}}",
          },
          "Second"
        ),
      ],
      catalog,
      integrations: [],
    });

    const grouped = groupWorkflowIssuesForOverlay(issues);
    expect(grouped.missingRequiredFields[0]?.missingFields).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldKey: "channel" })])
    );
    expect(grouped.missingIntegrations).toEqual([
      expect.objectContaining({
        integrationType: "slack",
        nodeNames: expect.arrayContaining(["First", "Second"]),
      }),
    ]);
    expect(grouped.brokenReferences[0]?.brokenReferences[0]?.displayText).toBe(
      "Old"
    );
  });
});

describe("findUnconfiguredIntegrationNodes", () => {
  it("names enabled actions that need a connection and carry none", () => {
    const results = findUnconfiguredIntegrationNodes({
      nodes: [
        actionNode("a1", { actionType: "custom/send" }, "Notify"),
        actionNode(
          "a2",
          { actionType: "custom/send", integrationId: "int_1" },
          "Bound"
        ),
        actionNode("a3", { actionType: "Condition", condition: "true" }),
      ],
      catalog,
    });

    expect(results).toEqual([
      {
        nodeId: "a1",
        nodeLabel: "Notify",
        integrationType: "slack",
        integrationLabel: "Slack",
      },
    ]);
  });
});
