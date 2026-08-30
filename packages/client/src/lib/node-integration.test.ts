import { describe, expect, it } from "vitest";
import {
  repairNodeIntegration,
  repairNodeIntegrations,
  requiredIntegrationType,
} from "#src/lib/node-integration";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

/**
 * Which connection an action needs is the catalog's answer, so these cases need
 * one. The two entries are what the assembled surface holds for a plugin action
 * and for the engine's own Condition: one names a connection, the other needs
 * none.
 */
const served: ExtensionCatalog = {
  events: [],
  actions: [
    {
      id: "twilio/send-sms",
      label: "Send SMS",
      description: "Send an SMS via Twilio",
      category: "Twilio",
      integration: "twilio",
      configFields: [],
      outputFields: [],
    },
    {
      id: "Condition",
      label: "Condition",
      description: "Branch based on a condition",
      category: "System",
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [
    {
      type: "twilio",
      label: "Twilio",
      description: "Send SMS messages with Twilio",
      credentialFields: {},
      hasTest: true,
      hasWebhook: false,
    },
  ],
};

function actionNode(
  config: Record<string, unknown>,
  id = "node_1"
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: "Step", type: "action", config },
  };
}

const twilioConnection = { id: "int_twilio", type: "twilio" };
const otherTwilioConnection = { id: "int_twilio_2", type: "twilio" };
const slackConnection = { id: "int_slack", type: "slack" };

describe("requiredIntegrationType", () => {
  it("reads the integration a plugin action names", () => {
    expect(requiredIntegrationType(served, "twilio/send-sms")).toBe("twilio");
  });

  it("is undefined for an action that needs no connection", () => {
    expect(requiredIntegrationType(served, "Condition")).toBeUndefined();
  });
});

describe("repairNodeIntegration", () => {
  it("selects the only connection of the right kind", () => {
    const node = actionNode({ actionType: "twilio/send-sms" });

    const repaired = repairNodeIntegration(served, node, [twilioConnection]);

    expect(repaired.data.config?.integrationId).toBe("int_twilio");
  });

  it("clears an id when no connection of that kind is left", () => {
    const node = actionNode({
      actionType: "twilio/send-sms",
      integrationId: "int_deleted",
    });

    const repaired = repairNodeIntegration(served, node, [slackConnection]);

    expect(repaired.data.config?.integrationId).toBeUndefined();
  });

  it("leaves the choice alone when more than one connection would fit", () => {
    const node = actionNode({
      actionType: "twilio/send-sms",
      integrationId: "int_deleted",
    });

    const repaired = repairNodeIntegration(served, node, [
      twilioConnection,
      otherTwilioConnection,
    ]);

    expect(repaired).toBe(node);
  });

  it("returns the same object when the stored id is still valid", () => {
    const node = actionNode({
      actionType: "twilio/send-sms",
      integrationId: "int_twilio",
    });

    // Identity, not just equality: the graph store reads a new node object as
    // an edit and queues an autosave.
    expect(repairNodeIntegration(served, node, [twilioConnection])).toBe(node);
  });

  it("leaves a node with no action type alone", () => {
    const node = actionNode({});

    expect(repairNodeIntegration(served, node, [twilioConnection])).toBe(node);
  });

  it("leaves an action that needs no connection alone", () => {
    const node = actionNode({ actionType: "Condition" });

    expect(repairNodeIntegration(served, node, [twilioConnection])).toBe(node);
  });

  it("does not invent an id for a node that never had one", () => {
    const node = actionNode({ actionType: "twilio/send-sms" });

    // No candidates and nothing stored means there is nothing to repair.
    expect(repairNodeIntegration(served, node, [slackConnection])).toBe(node);
  });
});

describe("repairNodeIntegrations", () => {
  it("returns the same array when every node is already correct", () => {
    const nodes = [
      actionNode({
        actionType: "twilio/send-sms",
        integrationId: "int_twilio",
      }),
      actionNode({ actionType: "Condition" }, "node_2"),
    ];

    expect(repairNodeIntegrations(served, nodes, [twilioConnection])).toBe(
      nodes
    );
  });

  it("repairs only the nodes that need it", () => {
    const healthy = actionNode(
      { actionType: "twilio/send-sms", integrationId: "int_twilio" },
      "node_1"
    );
    const stale = actionNode(
      { actionType: "twilio/send-sms", integrationId: "int_gone" },
      "node_2"
    );

    const repaired = repairNodeIntegrations(
      served,
      [healthy, stale],
      [twilioConnection]
    );

    expect(repaired).not.toBe([healthy, stale]);
    expect(repaired[0]).toBe(healthy);
    expect(repaired[1].data.config?.integrationId).toBe("int_twilio");
  });
});
