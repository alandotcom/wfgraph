import { describe, expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { emptyLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import {
  comparisonFields,
  changedNodeTitle,
} from "#src/components/workflow/comparison-properties";

const catalog = { actions: [], entities: [], events: [], integrations: [] };

describe("changedNodeTitle", () => {
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

    expect(changedNodeTitle(catalog, payload, payload.nodeChanges[0]!)).toBe(
      "Unavailable action"
    );
  });
});

describe("Lifecycle comparison fields", () => {
  it("leaves test payloads out of an added Lifecycle node's values", () => {
    const payload: WorkflowComparisonPayload = {
      baseVersion: null,
      proposedVersion: 1,
      baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: [
          {
            id: "lifecycle",
            type: "lifecycle",
            position: { x: 0, y: 0 },
            data: {
              label: "Lifecycle",
              type: "lifecycle",
              config: {
                lifecycleRules: {
                  ...emptyLifecycleRules,
                  allowManualStart: true,
                },
                testPayloads: { manual: { patientId: "pat_1" } },
              },
            },
          },
        ],
        edges: [],
      }),
      hasChanges: true,
      nodeChanges: [{ nodeId: "lifecycle", kind: "added", fields: [] }],
      edgeChanges: [],
    };

    expect(
      comparisonFields(catalog, payload, payload.nodeChanges[0]!).map(
        (field) => field.key
      )
    ).toEqual([
      "snapshot:type",
      "snapshot:label",
      "snapshot:config:lifecycleRules",
    ]);
  });
});

describe("comparisonFields row keys", () => {
  it("keys a row by its path alone, adding the position only for a repeated path", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        {
          id: "step_1",
          type: "action",
          position: { x: 0, y: 0 },
          data: { label: "Step", type: "action" },
        },
      ],
      edges: [],
    });
    const payload: WorkflowComparisonPayload = {
      baseVersion: null,
      proposedVersion: 1,
      baseGraph: graph,
      draftGraph: graph,
      hasChanges: true,
      nodeChanges: [],
      edgeChanges: [],
    };
    const label = {
      path: ["data", "label"],
      kind: "modified" as const,
      before: "A",
      after: "B",
    };
    const description = { ...label, path: ["data", "description"] };
    const keys = (fields: (typeof label)[]) =>
      comparisonFields(catalog, payload, {
        nodeId: "step_1",
        kind: "modified",
        fields,
      }).map((field) => field.key);

    expect(keys([label])).toEqual(['field:["data","label"]']);
    expect(keys([description, label])).toEqual([
      'field:["data","description"]',
      'field:["data","label"]',
    ]);
    expect(keys([label, label])).toEqual([
      'field:["data","label"]:0',
      'field:["data","label"]:1',
    ]);
  });
});
