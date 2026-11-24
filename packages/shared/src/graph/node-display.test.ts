import { describe, expect, it } from "vitest";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "#src/extensions/catalog";
import {
  currentTemplateDisplayText,
  currentTokenDisplayText,
  tokenSourceIsLive,
  trackedEntityTypeOf,
} from "#src/graph/node-display";
import {
  ENTITY_STATE_SOURCE_ID,
  formatTemplateToken,
  matchTemplateToken,
} from "#src/graph/node-references";
import type { WorkflowNode } from "#src/graph/types";

const donor: WorkflowNode = {
  id: "step_1",
  position: { x: 0, y: 0 },
  data: { label: "Donor", type: "action", config: {} },
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

describe("currentTokenDisplayText", () => {
  it("names a renamed step by its current label", () => {
    const token = tokenOf(
      formatTemplateToken({
        nodeId: "step_1",
        nodeLabel: "Hello Look Up Donor",
        fieldPath: "firstName",
      })
    );

    expect(currentTokenDisplayText(token, [donor], catalog, undefined)).toBe(
      "Donor.firstName"
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

    expect(currentTokenDisplayText(token, [donor], catalog, undefined)).toBe(
      "Send Email.id"
    );
  });

  it("names a token of the tracked Entity by its catalog label", () => {
    expect(
      currentTokenDisplayText(
        tokenOf(patientToken),
        [donor],
        catalog,
        "crm/patient"
      )
    ).toBe("Patient.status");
  });

  // The badge draws such a token broken, holding the label it was written
  // with, because the run has no state of that Entity type to read.
  it.each([
    ["tracks another Entity type", "crm/lead"],
    ["tracks no Entity", undefined],
  ])(
    "keeps the stored label for an Entity token when the workflow %s",
    (_case, trackedEntityType) => {
      const token = tokenOf(patientToken);

      expect(
        currentTokenDisplayText(token, [donor], catalog, trackedEntityType)
      ).toBe("Old Patient.status");
      expect(
        tokenSourceIsLive(token, [donor], catalog, trackedEntityType)
      ).toBe(false);
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
      currentTokenDisplayText(token, [donor], catalog, "crm/unknown")
    ).toBe("Lead.stage");
  });
});

describe("trackedEntityTypeOf", () => {
  it("reads the tracked Entity type off the Lifecycle node", () => {
    expect(trackedEntityTypeOf([donor, lifecycleTracking("crm/patient")])).toBe(
      "crm/patient"
    );
  });

  it("answers undefined for a workflow with no Lifecycle node", () => {
    expect(trackedEntityTypeOf([donor])).toBeUndefined();
  });
});

describe("currentTemplateDisplayText", () => {
  it("drops the node id so a person reads the current label and path", () => {
    const token = formatTemplateToken({
      nodeId: "step_1",
      nodeLabel: "Hello Look Up Donor",
      fieldPath: "firstName",
    });

    expect(currentTemplateDisplayText(`Hi ${token}!`, [donor], catalog)).toBe(
      "Hi Donor.firstName!"
    );
  });

  it("reads the tracked Entity off the graph's Lifecycle node", () => {
    expect(
      currentTemplateDisplayText(
        `Status: ${patientToken}`,
        [donor, lifecycleTracking("crm/patient")],
        catalog
      )
    ).toBe("Status: Patient.status");
    expect(
      currentTemplateDisplayText(
        `Status: ${patientToken}`,
        [donor, lifecycleTracking("crm/lead")],
        catalog
      )
    ).toBe("Status: Old Patient.status");
  });

  it("leaves surrounding prose and a token without a path", () => {
    const token = formatTemplateToken({
      nodeId: "step_gone",
      nodeLabel: "Send Email",
    });

    expect(currentTemplateDisplayText(`id is ${token}`, [donor], catalog)).toBe(
      "id is Send Email"
    );
  });
});
