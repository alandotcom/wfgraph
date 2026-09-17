import { describe, expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { emptyLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  comparisonFields,
  formatComparisonValue,
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
const mailCatalog: ExtensionCatalog = {
  entities: [],
  events: [],
  integrations: [],
  actions: [
    {
      id: "mail/send",
      label: "Send email",
      description: "",
      category: "Mail",
      configFields: [
        { key: "subject", label: "Subject", type: "text" },
        { key: "recipients", label: "Recipients", type: "text" },
      ],
      outputFields: [],
    },
  ],
};

function mailGraph(label: string, subject: string) {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "step_1",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          type: "action",
          label,
          enabled: true,
          config: { actionType: "mail/send", subject, recipients: ["a", "b"] },
        },
      },
    ],
    edges: [],
  });
}

const payload: WorkflowComparisonPayload = {
  baseVersion: {
    id: "version_1",
    version: 1,
    publishedAt: "2026-08-23T00:00:00.000Z",
    isCurrent: true,
  },
  proposedVersion: 2,
  baseGraph: mailGraph("Published email", "Before"),
  draftGraph: mailGraph("Current email", "After"),
  hasChanges: true,
  nodeChanges: [
    {
      nodeId: "step_1",
      kind: "modified",
      fields: [
        {
          path: ["data", "label"],
          kind: "modified",
          before: "Published email",
          after: "Current email",
        },
        {
          path: ["data", "config", "subject"],
          kind: "modified",
          before: "Before",
          after: "After",
        },
      ],
    },
  ],
  edgeChanges: [],
};

describe("comparison fields of a mail step", () => {
  it("uses catalog labels for modified fields rather than machine paths", () => {
    const fields = comparisonFields(
      mailCatalog,
      payload,
      payload.nodeChanges[0]!
    );

    expect(fields).toEqual([
      {
        key: 'field:["data","label"]',
        label: "Label",
        before: "Published email",
        after: "Current email",
        category: "behavior",
      },
      {
        key: 'field:["data","config","subject"]',
        label: "Subject",
        before: "Before",
        after: "After",
        category: "behavior",
      },
    ]);
    expect(fields.map((field) => field.label).join(" ")).not.toContain(
      "config.subject"
    );
  });

  it("shows only the current snapshot for added nodes and the published snapshot for removed nodes", () => {
    const added = comparisonFields(mailCatalog, payload, {
      nodeId: "step_1",
      kind: "added",
      fields: [],
    });
    const removed = comparisonFields(mailCatalog, payload, {
      nodeId: "step_1",
      kind: "removed",
      fields: [],
    });

    expect(added.find((field) => field.label === "Subject")).toEqual({
      key: "snapshot:config:subject",
      label: "Subject",
      after: "After",
    });
    expect(removed.find((field) => field.label === "Subject")).toEqual({
      key: "snapshot:config:subject",
      label: "Subject",
      before: "Before",
    });
  });

  it("summarizes structured values while preserving scalar values", () => {
    expect(formatComparisonValue(["a", "b"])).toBe("2 items");
    expect(formatComparisonValue({ recipient: "a" })).toBe("1 field");
    expect(formatComparisonValue(false)).toBe("Disabled");
    expect(formatComparisonValue("Subject")).toBe("Subject");
  });

  it("uses generic labels when a diff path or action id is unavailable", () => {
    const unavailable = {
      ...payload,
      draftGraph: createSerializedWorkflowGraph({
        nodes: [
          {
            id: "step_1",
            type: "action",
            position: { x: 0, y: 0 },
            data: {
              type: "action",
              label: "Current email",
              config: {
                actionType: "internal/private-action",
                secret_flag: true,
              },
            },
          },
        ],
        edges: [],
      }),
      nodeChanges: [
        {
          nodeId: "step_1",
          kind: "modified" as const,
          fields: [
            {
              path: ["internal", "secret_flag"],
              kind: "modified" as const,
              before: false,
              after: true,
            },
          ],
        },
      ],
    };

    const fields = comparisonFields(
      mailCatalog,
      unavailable,
      unavailable.nodeChanges[0]!
    );
    const snapshotFields = comparisonFields(mailCatalog, unavailable, {
      nodeId: "step_1",
      kind: "added",
      fields: [],
    });
    expect(fields.map((field) => field.label).join(" ")).toContain("Property");
    expect(fields.map((field) => field.label).join(" ")).not.toContain(
      "secret_flag"
    );
    expect(JSON.stringify(snapshotFields)).toContain("Unavailable action");
    expect(JSON.stringify(snapshotFields)).not.toContain("private-action");
  });

  it("gives duplicate generic labels distinct machine keys", () => {
    const fields = comparisonFields(mailCatalog, payload, {
      nodeId: "step_1",
      kind: "modified",
      fields: [
        {
          path: ["internal", "first"],
          kind: "modified",
          before: false,
          after: true,
        },
        {
          path: ["internal", "second"],
          kind: "modified",
          before: false,
          after: true,
        },
      ],
    });

    expect(fields.map((field) => field.label)).toEqual([
      "Property",
      "Property",
    ]);
    expect(new Set(fields.map((field) => field.key)).size).toBe(2);
  });
});
