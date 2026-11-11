import { describe, expect, it } from "vitest";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  actionNodeDisplayTitle,
  getIntegrationFromActionType,
} from "#src/components/workflow/nodes/action-node";
import { COMPARISON_NODE_ANNOTATION } from "#src/lib/workflow-graph-types";

describe("actionNodeDisplayTitle", () => {
  it("hides an unavailable action id while rendering a comparison", () => {
    const data = {
      label: "",
      type: "action" as const,
      config: { actionType: "private/internal-action" },
      [COMPARISON_NODE_ANNOTATION]: { kind: "removed" as const },
    };
    const catalog = { actions: [], entities: [], events: [], integrations: [] };

    expect(actionNodeDisplayTitle(data, catalog)).toBe("Unavailable action");
    expect(
      actionNodeDisplayTitle(
        { ...data, [COMPARISON_NODE_ANNOTATION]: undefined },
        catalog
      )
    ).toBe("private/internal-action");
  });
});

describe("getIntegrationFromActionType", () => {
  const action = {
    description: "",
    configFields: [],
    outputFields: [],
  };
  const catalog: ExtensionCatalog = {
    events: [],
    entities: [],
    actions: [
      {
        ...action,
        id: "slack/send-message",
        label: "Send message",
        category: "Slack",
        integration: "slack",
      },
      {
        ...action,
        id: "appointments/cancel",
        label: "Cancel Appointment",
        category: "Appointments",
      },
      { ...action, id: "Wait", label: "Wait", category: "System" },
    ],
    integrations: [
      {
        type: "slack",
        label: "Slack workspace",
        description: "",
        credentialFields: {},
        hasTest: false,
        hasWebhook: false,
      },
    ],
  };

  it("names an integration's action by the integration's label", () => {
    expect(getIntegrationFromActionType(catalog, "slack/send-message")).toBe(
      "Slack workspace"
    );
  });

  // The inspector reads "Appointments · Cancel Appointment" for this step, and
  // the canvas badge names the same category.
  it("names a host action by the category the host gave it", () => {
    expect(getIntegrationFromActionType(catalog, "appointments/cancel")).toBe(
      "Appointments"
    );
  });

  it("names a built-in step and an unknown action as System", () => {
    expect(getIntegrationFromActionType(catalog, "Wait")).toBe("System");
    expect(getIntegrationFromActionType(catalog, "gone/action")).toBe("System");
  });
});
