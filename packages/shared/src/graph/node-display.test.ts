import { describe, expect, it } from "vitest";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "#src/extensions/catalog";
import {
  currentTemplateDisplayText,
  currentTokenDisplay,
  currentTokenDisplayText,
} from "#src/graph/node-display";
import {
  ENTITY_STATE_SOURCE_ID,
  formatTemplateToken,
  matchTemplateToken,
} from "#src/graph/node-references";
import type { WorkflowNode } from "#src/graph/types";

const member: WorkflowNode = {
  id: "step_1",
  position: { x: 0, y: 0 },
  data: { label: "Member", type: "action", config: {} },
};

const catalog: ExtensionCatalog = {
  ...emptyExtensionCatalog,
  entities: [
    {
      type: "crm/patient",
      label: "Patient",
      stateFields: [],
      stateSchemaDigest: "digest",
    },
  ],
};

/** The Lifecycle node of a workflow that tracks `type`. */
function lifecycleTracking(type: string): WorkflowNode {
  return {
    id: "entry",
    position: { x: 0, y: -100 },
    data: {
      label: "Patients",
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvents: [],
          cancelEvents: [],
          concurrency: "unlimited",
          trackedEntity: { type, bindings: {} },
        },
      },
    },
  };
}

const patientToken = formatTemplateToken({
  nodeId: ENTITY_STATE_SOURCE_ID,
  sourceType: "crm/patient",
  nodeLabel: "Old Patient",
  fieldPath: "status",
});

function tokenOf(raw: string) {
  const token = matchTemplateToken(raw);
  if (!token) {
    throw new Error("fixture is not a template token");
  }
  return token;
}

describe("currentTokenDisplay", () => {
  it("names a renamed step by its current label", () => {
    const token = tokenOf(
      formatTemplateToken({
        nodeId: "step_1",
        nodeLabel: "Hello Look Up Member",
        fieldPath: "firstName",
      })
    );

    expect(currentTokenDisplayText(token, [member], catalog)).toBe(
      "Member.firstName"
    );
  });

  it("keeps the stored label when the step is gone", () => {
    const token = tokenOf(
      formatTemplateToken({
        nodeId: "step_gone",
        nodeLabel: "Send Email",
        fieldPath: "id",
      })
    );

    expect(currentTokenDisplayText(token, [member], catalog)).toBe(
      "Send Email.id"
    );
  });

  it("names a token of the Entity the Lifecycle node tracks by its catalog label", () => {
    const token = tokenOf(patientToken);
    const nodes = [member, lifecycleTracking("crm/patient")];

    expect(currentTokenDisplay(token, nodes, catalog)).toEqual({
      text: "Patient.status",
      sourceIsLive: true,
    });
  });

  // The badge draws such a token broken, holding the label it was written
  // with, because the run has no state of that Entity type to read.
  it.each([
    ["tracks another Entity type", [member, lifecycleTracking("crm/lead")]],
    ["has no Lifecycle node", [member]],
  ])(
    "keeps the stored label for an Entity token when the workflow %s",
    (_case, nodes) => {
      const token = tokenOf(patientToken);

      expect(currentTokenDisplay(token, nodes, catalog)).toEqual({
        text: "Old Patient.status",
        sourceIsLive: false,
      });
    }
  );

  it("keeps the stored label for a tracked Entity type the catalog does not hold", () => {
    const token = tokenOf(
      formatTemplateToken({
        nodeId: ENTITY_STATE_SOURCE_ID,
        sourceType: "crm/unknown",
        nodeLabel: "Lead",
        fieldPath: "stage",
      })
    );

    expect(
      currentTokenDisplayText(
        token,
        [member, lifecycleTracking("crm/unknown")],
        catalog
      )
    ).toBe("Lead.stage");
  });
});

describe("currentTemplateDisplayText", () => {
  it("drops the node id so a person reads the current label and path", () => {
    const token = formatTemplateToken({
      nodeId: "step_1",
      nodeLabel: "Hello Look Up Member",
      fieldPath: "firstName",
    });

    expect(currentTemplateDisplayText(`Hi ${token}!`, [member], catalog)).toBe(
      "Hi Member.firstName!"
    );
  });

  it("reads the tracked Entity off the graph's Lifecycle node", () => {
    expect(
      currentTemplateDisplayText(
        `Status: ${patientToken}`,
        [member, lifecycleTracking("crm/patient")],
        catalog
      )
    ).toBe("Status: Patient.status");
    expect(
      currentTemplateDisplayText(
        `Status: ${patientToken}`,
        [member, lifecycleTracking("crm/lead")],
        catalog
      )
    ).toBe("Status: Old Patient.status");
  });

  it("leaves surrounding prose and a token without a path", () => {
    const token = formatTemplateToken({
      nodeId: "step_gone",
      nodeLabel: "Send Email",
    });

    expect(
      currentTemplateDisplayText(`id is ${token}`, [member], catalog)
    ).toBe("id is Send Email");
  });
});
