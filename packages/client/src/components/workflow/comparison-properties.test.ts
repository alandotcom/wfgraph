import { describe, expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import {
  comparisonFields,
  comparisonNodeTitle,
} from "#src/components/workflow/comparison-properties";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const catalog = { actions: [], events: [], integrations: [] };

describe("comparisonNodeTitle", () => {
  it("keeps internal action ids out of comparison labels", () => {
    const payload: WorkflowComparisonPayload = {
      baseVersion: null,
      proposedVersion: 1,
      baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: [
          {
            id: "step_1",
            type: "action",
            position: { x: 0, y: 0 },
            data: {
              label: "  ",
              type: "action",
              config: { actionType: "private/internal-action" },
            },
          },
        ],
        edges: [],
      }),
      hasChanges: true,
      nodeChanges: [{ nodeId: "step_1", kind: "added", fields: [] }],
      edgeChanges: [],
    };

    expect(comparisonNodeTitle(catalog, payload, payload.nodeChanges[0]!)).toBe(
      "Unavailable action"
    );
  });
});

describe("Lifecycle comparison fields", () => {
  it("labels Event test payload values from their declared payload paths", () => {
    const eventName = "app/appointment.created";
    const eventCatalog: ExtensionCatalog = {
      actions: [],
      integrations: [],
      events: [
        {
          name: eventName,
          label: "Appointment created",
          payloadFields: [
            {
              path: "appointment.id",
              description: "Appointment ID",
            },
            { path: "appointment.patientName" },
            { path: "appointment.startsAt" },
            { path: "appointment.status" },
            { path: "occurredAt" },
          ],
        },
      ],
    };
    const graph = createSerializedWorkflowGraph({
      nodes: [
        {
          id: "lifecycle",
          type: "lifecycle",
          position: { x: 0, y: 0 },
          data: { label: "Lifecycle", type: "lifecycle", config: {} },
        },
      ],
      edges: [],
    });
    const fieldPaths = [
      ["appointment", "id"],
      ["appointment", "patientName"],
      ["appointment", "startsAt"],
      ["appointment", "status"],
      ["occurredAt"],
    ];
    const payload: WorkflowComparisonPayload = {
      baseVersion: null,
      proposedVersion: 1,
      baseGraph: graph,
      draftGraph: graph,
      hasChanges: true,
      nodeChanges: [
        {
          nodeId: "lifecycle",
          kind: "modified",
          fields: fieldPaths.map((fieldPath) => ({
            path: [
              "data",
              "config",
              "testPayloads",
              "byEvent",
              eventName,
              ...fieldPath,
            ],
            kind: "added" as const,
            after: "value",
          })),
        },
      ],
      edgeChanges: [],
    };

    expect(
      comparisonFields(eventCatalog, payload, payload.nodeChanges[0]!).map(
        (field) => field.label
      )
    ).toEqual([
      "Appointment ID",
      "Patient Name",
      "Starts At",
      "Status",
      "Occurred At",
    ]);
  });
});
