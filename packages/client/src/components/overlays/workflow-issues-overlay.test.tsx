import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
  repairIntegrationsAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { workflowIssueCount } from "#src/components/overlays/workflow-issues-overlay";

/**
 * The issues dialog's Add button creates a connection and then repairs the
 * open graph against the refreshed list. The repair itself is this atom; the
 * overlay only calls it. What used to be covered by mocking the credential form
 * is the write that points unbound nodes at the new connection.
 */

const ACTION = "linear/find-issues";

const linearCatalog = {
  events: [],
  actions: [
    {
      id: ACTION,
      label: "Find Issues",
      description: "Find issues matching a filter",
      category: "Linear",
      integration: "linear",
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [
    {
      type: "linear",
      label: "Linear",
      description: "Linear issue tracking",
      credentialFields: {},
      hasTest: true,
    },
  ],
};

const unboundNode: WorkflowNode = {
  id: "node_1",
  type: "action",
  position: { x: 0, y: 0 },
  data: {
    label: "Did they reschedule?",
    type: "action",
    config: { actionType: ACTION },
  },
};

describe("repairIntegrationsAtom", () => {
  it("binds flagged nodes to a connection that now exists", () => {
    const store = createStore();
    store.set(loadWorkflowGraphAtom, { nodes: [unboundNode], edges: [] });

    store.set(repairIntegrationsAtom, {
      integrations: [{ id: "int_linear", type: "linear" }],
      catalog: linearCatalog,
    });

    expect(store.get(nodesAtom)[0]?.data.config?.integrationId).toBe(
      "int_linear"
    );
  });
});

describe("workflowIssueCount", () => {
  it("counts issue instances rather than grouped rows", () => {
    expect(
      workflowIssueCount({
        totalIssues: 6,
        missingIntegrations: [
          {
            integrationType: "linear",
            integrationLabel: "Linear",
            nodeNames: ["Find issues", "Create issue"],
          },
        ],
        brokenReferences: [
          {
            nodeId: "notify",
            nodeLabel: "Notify",
            brokenReferences: [
              {
                fieldKey: "message",
                fieldLabel: "Message",
                referencedNodeId: "missing-a",
                displayText: "Missing A",
              },
              {
                fieldKey: "channel",
                fieldLabel: "Channel",
                referencedNodeId: "missing-b",
                displayText: "Missing B",
              },
            ],
          },
        ],
        missingRequiredFields: [
          {
            nodeId: "send",
            nodeLabel: "Send",
            missingFields: [
              { fieldKey: "to", fieldLabel: "To" },
              { fieldKey: "subject", fieldLabel: "Subject" },
            ],
          },
        ],
      })
    ).toBe(6);
  });
});
