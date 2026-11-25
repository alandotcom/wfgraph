import { describe, expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { emptyLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import {
  type ConditionModel,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  ConditionValue,
  ValueNote,
} from "#src/components/workflow/comparison-field-labels";
import {
  comparisonFields,
  comparisonMetadataNotice,
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

/** The two built-in actions as the server's catalog lists them, with no fields. */
const builtInCatalog: ExtensionCatalog = {
  ...catalog,
  actions: [BUILT_IN_ACTION_IDS.condition, BUILT_IN_ACTION_IDS.wait].map(
    (id) => ({
      id,
      label: id,
      description: "",
      category: "System",
      configFields: [],
      outputFields: [],
    })
  ),
};

/** A Condition whose one rule compares `minutes` against a number field. */
function minutesRule(minutes: number): ConditionModel {
  return {
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group",
        logic: "and",
        conditions: [
          {
            id: "rule",
            field: "$node:lifecycle.minutesUntil",
            fieldType: "number",
            operator: "greater_than",
            value: minutes,
          },
        ],
      },
    ],
  };
}

function conditionNode(minutes: number): WorkflowNode {
  return {
    id: "condition",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Enough time for reminders?",
      type: "action",
      config: {
        actionType: BUILT_IN_ACTION_IDS.condition,
        condition: `node.minutesUntil > ${minutes}`,
        conditionModel: serializeConditionModel(minutesRule(minutes)),
      },
    },
  };
}

function waitNode(config: Record<string, unknown>): WorkflowNode {
  return {
    id: "wait",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Wait a day",
      type: "action",
      config: { actionType: BUILT_IN_ACTION_IDS.wait, ...config },
    },
  };
}

function builtInPayload(
  before: WorkflowNode,
  after: WorkflowNode,
  fields: WorkflowComparisonPayload["nodeChanges"][number]["fields"]
): WorkflowComparisonPayload {
  return {
    baseVersion: null,
    proposedVersion: 2,
    baseGraph: createSerializedWorkflowGraph({ nodes: [before], edges: [] }),
    draftGraph: createSerializedWorkflowGraph({ nodes: [after], edges: [] }),
    hasChanges: true,
    nodeChanges: [{ nodeId: before.id, kind: "modified", fields }],
    edgeChanges: [],
  };
}

describe("comparison fields of a Condition", () => {
  it("shows a changed Condition as one row of rules for each side", () => {
    const comparison = builtInPayload(conditionNode(30), conditionNode(45), [
      {
        path: ["data", "config", "condition"],
        kind: "modified",
        before: "node.minutesUntil > 30",
        after: "node.minutesUntil > 45",
      },
      {
        path: ["data", "config", "conditionModel"],
        kind: "modified",
        before: serializeConditionModel(minutesRule(30)),
        after: serializeConditionModel(minutesRule(45)),
      },
    ]);
    const fields = comparisonFields(
      builtInCatalog,
      comparison,
      comparison.nodeChanges[0]!
    );

    expect(fields.map((field) => [field.key, field.label])).toEqual([
      ["field:condition-rules", "Continue when"],
    ]);
    const [rules] = fields;
    expect(rules?.before).toBeInstanceOf(ConditionValue);
    expect(rules?.after).toBeInstanceOf(ConditionValue);
    expect(
      rules?.before instanceof ConditionValue &&
        rules.before.model.groups[0]?.conditions[0]
    ).toMatchObject({ value: 30 });
    expect(
      rules?.after instanceof ConditionValue &&
        rules.after.model.groups[0]?.conditions[0]
    ).toMatchObject({ value: 45 });
    expect(
      comparisonMetadataNotice({
        catalog: builtInCatalog,
        payload: comparison,
        change: comparison.nodeChanges[0]!,
        fields,
      })
    ).toBeNull();
  });

  it("shows an added Condition's rules as one row and leaves the expression out", () => {
    const node = conditionNode(30);
    const comparison: WorkflowComparisonPayload = {
      ...builtInPayload(node, node, []),
      baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      nodeChanges: [{ nodeId: node.id, kind: "added", fields: [] }],
    };
    const fields = comparisonFields(
      builtInCatalog,
      comparison,
      comparison.nodeChanges[0]!
    );

    expect(fields.map((field) => field.label)).toEqual([
      "Type",
      "Label",
      "Action",
      "Continue when",
    ]);
    expect(fields.at(-1)?.after).toBeInstanceOf(ConditionValue);
  });

  it("says so when stored rules cannot be read", () => {
    const broken = conditionNode(30);
    const comparison = builtInPayload(
      broken,
      {
        ...broken,
        data: {
          ...broken.data,
          config: { ...broken.data.config, conditionModel: "{not json" },
        },
      },
      [
        {
          path: ["data", "config", "conditionModel"],
          kind: "modified",
          before: serializeConditionModel(minutesRule(30)),
          after: "{not json",
        },
      ]
    );
    const [rules] = comparisonFields(
      builtInCatalog,
      comparison,
      comparison.nodeChanges[0]!
    );

    expect(rules?.after).toEqual(new ValueNote("Rules changed"));
  });
});

describe("comparison fields of a Wait", () => {
  it("names a Wait's settings and choices in the words its form uses", () => {
    const comparison = builtInPayload(
      waitNode({ waitDuration: "30m", waitGateMode: "off" }),
      waitNode({ waitDuration: "45m", waitGateMode: "max_lateness" }),
      [
        {
          path: ["data", "config", "waitDuration"],
          kind: "modified",
          before: "30m",
          after: "45m",
        },
        {
          path: ["data", "config", "waitGateMode"],
          kind: "modified",
          before: "off",
          after: "max_lateness",
        },
      ]
    );
    const fields = comparisonFields(
      builtInCatalog,
      comparison,
      comparison.nodeChanges[0]!
    );

    expect(
      fields.map(({ label, before, after }) => ({ label, before, after }))
    ).toEqual([
      { label: "Duration", before: "30m", after: "45m" },
      {
        label: "If the scheduled time has passed",
        before: "Continue immediately",
        after: "Continue within a limit",
      },
    ]);
    expect(
      comparisonMetadataNotice({
        catalog: builtInCatalog,
        payload: comparison,
        change: comparison.nodeChanges[0]!,
        fields,
      })
    ).toBeNull();
  });

  it("reads an added Wait's stored choices as their labels", () => {
    const node = waitNode({ waitMode: "delay", waitDuration: "1d" });
    const comparison: WorkflowComparisonPayload = {
      ...builtInPayload(node, node, []),
      baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      nodeChanges: [{ nodeId: node.id, kind: "added", fields: [] }],
    };
    const fields = comparisonFields(
      builtInCatalog,
      comparison,
      comparison.nodeChanges[0]!
    );

    expect(
      fields
        .filter((field) => field.key.startsWith("snapshot:config:"))
        .map(({ label, after }) => ({ label, after }))
    ).toEqual([
      { label: "Duration", after: "1d" },
      { label: "How should this step wait?", after: "Wait for time" },
    ]);
  });
});
