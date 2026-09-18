import { describe, expect, it } from "vitest";
import { diffWorkflowGraphs } from "#src/backend/services/workflows/graph-diff";
import { semanticWorkflowGraphsEqual } from "#src/backend/services/workflows/semantic-graph";
import {
  draftDiffersFromPublished,
  graphDigest,
} from "#src/backend/services/workflows/version-digest";
import { classifyWorkflowComparison } from "@wfgraph/shared/graph/change-classification";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { emptyLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type {
  SerializedWorkflowGraph,
  WorkflowEdge,
  WorkflowNode,
} from "@wfgraph/shared/graph/types";

function node(id: string, overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 10, y: 20 },
    data: {
      label: id,
      type: "action",
      config: { actionType: "example/send", nested: { value: "original" } },
    },
    ...overrides,
  };
}

function graph(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[] = []
): SerializedWorkflowGraph {
  return createSerializedWorkflowGraph({ nodes, edges });
}

function withStoredEnabled(
  source: SerializedWorkflowGraph,
  nodeId: string,
  enabled: boolean
): SerializedWorkflowGraph {
  return {
    ...source,
    nodes: source.nodes.map((serialized) =>
      serialized.key !== nodeId
        ? serialized
        : {
            ...serialized,
            attributes: {
              ...serialized.attributes,
              data: { ...serialized.attributes.data, enabled },
            },
          }
    ),
  };
}

describe("diffWorkflowGraphs", () => {
  it("ignores graph and editor geometry changes", () => {
    const base = graph([node("action")]);
    const draft: SerializedWorkflowGraph = {
      ...base,
      attributes: { viewport: { x: 100, y: 200 }, theme: "dark" },
      nodes: [
        {
          ...base.nodes[0],
          attributes: {
            ...base.nodes[0].attributes,
            position: { x: 900, y: 700 },
            width: 999,
            height: 888,
            measured: { width: 777, height: 666 },
          },
        },
      ],
    };

    expect(diffWorkflowGraphs(base, draft)).toEqual({
      hasChanges: false,
      nodeChanges: [],
      edgeChanges: [],
    });
  });

  it("ignores node and edge array order", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges: WorkflowEdge[] = [
      { id: "edge-a", source: "a", target: "b" },
      { id: "edge-b", source: "b", target: "c", targetHandle: "in" },
    ];

    expect(
      diffWorkflowGraphs(
        graph(nodes, edges),
        graph(nodes.toReversed(), edges.toReversed())
      )
    ).toEqual({ hasChanges: false, nodeChanges: [], edgeChanges: [] });
  });

  it("reports added, modified, and removed nodes by stable id", () => {
    const base = graph([
      node("removed"),
      node("modified", {
        data: {
          label: "Before",
          type: "action",
          config: {
            actionType: "example/send",
            nested: { value: "before", retries: 1 },
          },
        },
      }),
    ]);
    const draft = graph([
      node("added", {
        parentId: "group",
        data: {
          label: "Added",
          type: "action",
          config: { actionType: "example/receive" },
        },
      }),
      node("modified", {
        data: {
          label: "After",
          type: "action",
          enabled: false,
          config: {
            actionType: "example/send",
            nested: { value: "after", retries: 1 },
          },
        },
      }),
    ]);

    const result = diffWorkflowGraphs(base, draft);

    expect(
      result.nodeChanges.map(({ nodeId, kind }) => ({ nodeId, kind }))
    ).toEqual([
      { nodeId: "added", kind: "added" },
      { nodeId: "modified", kind: "modified" },
      { nodeId: "removed", kind: "removed" },
    ]);
    expect(result.nodeChanges[0]?.fields).toEqual([
      {
        path: ["data", "config", "actionType"],
        kind: "added",
        after: "example/receive",
      },
      { path: ["data", "label"], kind: "added", after: "Added" },
      { path: ["data", "type"], kind: "added", after: "action" },
      { path: ["parentId"], kind: "added", after: "group" },
      { path: ["type"], kind: "added", after: "action" },
    ]);
    expect(result.nodeChanges[1]?.fields).toEqual([
      {
        path: ["data", "config", "nested", "value"],
        kind: "modified",
        before: "before",
        after: "after",
      },
      {
        path: ["data", "enabled"],
        kind: "added",
        after: false,
      },
      {
        path: ["data", "label"],
        kind: "modified",
        before: "Before",
        after: "After",
      },
    ]);
    expect(result.nodeChanges[2]?.fields).toEqual([
      {
        path: ["data", "config", "actionType"],
        kind: "removed",
        before: "example/send",
      },
      {
        path: ["data", "config", "nested", "value"],
        kind: "removed",
        before: "original",
      },
      { path: ["data", "label"], kind: "removed", before: "removed" },
      { path: ["data", "type"], kind: "removed", before: "action" },
      { path: ["type"], kind: "removed", before: "action" },
    ]);
    expect(result.hasChanges).toBe(true);
  });

  it("reports a Group's description and membership and no edge change", () => {
    const frame = (description: string): WorkflowNode => ({
      id: "group",
      type: "group",
      position: { x: 0, y: 0 },
      data: { label: "Outreach", type: "group", description },
    });
    const edges: WorkflowEdge[] = [{ id: "a-b", source: "a", target: "b" }];
    const ungrouped = graph([node("a"), node("b")], edges);
    const vertical = graph(
      [
        frame("vertical"),
        node("a", { parentId: "group" }),
        node("b", { parentId: "group" }),
      ],
      edges
    );
    const horizontal = graph(
      [
        frame("horizontal"),
        node("a", { parentId: "group" }),
        node("b", { parentId: "group" }),
      ],
      edges
    );

    const groupedDiff = diffWorkflowGraphs(ungrouped, vertical);
    expect(
      groupedDiff.nodeChanges.map(({ nodeId, kind }) => ({ nodeId, kind }))
    ).toEqual([
      { nodeId: "a", kind: "modified" },
      { nodeId: "b", kind: "modified" },
      { nodeId: "group", kind: "added" },
    ]);
    expect(groupedDiff.nodeChanges[0]?.fields).toEqual([
      { path: ["parentId"], kind: "added", after: "group" },
    ]);
    expect(groupedDiff.edgeChanges).toEqual([]);

    const turned = diffWorkflowGraphs(vertical, horizontal);
    expect(turned.nodeChanges).toEqual([
      {
        nodeId: "group",
        kind: "modified",
        fields: [
          {
            path: ["data", "description"],
            kind: "modified",
            before: "vertical",
            after: "horizontal",
          },
        ],
      },
    ]);
    expect(turned.edgeChanges).toEqual([]);
  });

  it("distinguishes a missing value from null", () => {
    const base = graph([
      node("config", {
        data: {
          label: "Config",
          type: "action",
          config: { actionType: "example/send" },
        },
      }),
    ]);
    const draft = graph([
      node("config", {
        data: {
          label: "Config",
          type: "action",
          config: { actionType: "example/send", optional: null },
        },
      }),
    ]);

    expect(diffWorkflowGraphs(base, draft).nodeChanges[0]?.fields).toEqual([
      { path: ["data", "config", "optional"], kind: "added", after: null },
    ]);
  });

  it("reports semantic edge changes as removal followed by addition", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const base = graph(nodes, [
      { id: "edge_changed", source: "a", target: "b", sourceHandle: "out" },
      { id: "edge_removed", source: "a", target: "c" },
    ]);
    const draft = graph(nodes, [
      {
        id: "edge_changed",
        source: "a",
        target: "c",
        sourceHandle: "out",
      },
      { id: "edge_added", source: "b", target: "c" },
    ]);

    expect(diffWorkflowGraphs(base, draft).edgeChanges).toEqual([
      { edgeId: "edge_added", kind: "added" },
      { edgeId: "edge_changed", kind: "removed" },
      { edgeId: "edge_changed", kind: "added" },
      { edgeId: "edge_removed", kind: "removed" },
    ]);
  });

  it("ignores an editor-generated edge id replacement", () => {
    const nodes = [node("a"), node("b")];
    const base = graph(nodes, [
      {
        id: "react-flow-edge-1",
        source: "a",
        target: "b",
        sourceHandle: "out",
        data: { condition: { expression: "true" } },
      },
    ]);
    const draft = graph(nodes, [
      {
        id: "react-flow-edge-2",
        source: "a",
        target: "b",
        sourceHandle: "out",
        data: { condition: { expression: "true" } },
      },
    ]);

    expect(diffWorkflowGraphs(base, draft)).toEqual({
      hasChanges: false,
      nodeChanges: [],
      edgeChanges: [],
    });
  });

  it("treats null handles and empty data as their omitted wire forms", () => {
    const nodes = [node("a"), node("b")];
    const base = graph(nodes, [
      {
        id: "edge-base",
        source: "a",
        target: "b",
        sourceHandle: null,
        targetHandle: null,
        data: {},
      },
    ]);
    const draft = graph(nodes, [
      { id: "edge-draft", source: "a", target: "b" },
    ]);

    expect(diffWorkflowGraphs(base, draft)).toEqual({
      hasChanges: false,
      nodeChanges: [],
      edgeChanges: [],
    });
  });

  it("matches duplicate identical edges deterministically", () => {
    const nodes = [node("a"), node("b")];
    const template = graph(nodes, [{ id: "edge-a", source: "a", target: "b" }]);
    const duplicate = {
      ...template.edges[0],
      key: "edge-b",
      attributes: { ...template.edges[0]!.attributes, id: "edge-b" },
    };
    const base: SerializedWorkflowGraph = {
      ...template,
      edges: [template.edges[0]!, duplicate],
    };
    const draft: SerializedWorkflowGraph = {
      ...template,
      edges: [
        {
          ...duplicate,
          key: "edge-c",
          attributes: { ...duplicate.attributes, id: "edge-c" },
        },
      ],
    };

    expect(diffWorkflowGraphs(base, draft).edgeChanges).toEqual([
      { edgeId: "edge-b", kind: "removed" },
    ]);
  });

  it("matches duplicate identical edges by sorted id whatever the input order", () => {
    const nodes = [node("a"), node("b")];
    const template = graph(nodes, [{ id: "edge-a", source: "a", target: "b" }]);
    const withId = (id: string) => ({
      ...template.edges[0]!,
      key: id,
      attributes: { ...template.edges[0]!.attributes, id },
    });
    const base: SerializedWorkflowGraph = {
      ...template,
      edges: [withId("edge-b"), withId("edge-a")],
    };
    const draft: SerializedWorkflowGraph = {
      ...template,
      edges: [withId("edge-c")],
    };

    expect(diffWorkflowGraphs(base, draft).edgeChanges).toEqual([
      { edgeId: "edge-b", kind: "removed" },
    ]);
  });

  it("treats equal sensitive values as equal despite object key order", () => {
    const base = graph([
      node("secret", {
        data: {
          label: "Secret",
          type: "action",
          config: {
            apiKey: "sk_live_original",
            options: { first: "one", second: "two" },
          },
        },
      }),
    ]);
    const draft = graph([
      node("secret", {
        data: {
          label: "Secret",
          type: "action",
          config: {
            options: { second: "two", first: "one" },
            apiKey: "sk_live_original",
          },
        },
      }),
    ]);

    expect(diffWorkflowGraphs(base, draft)).toEqual({
      hasChanges: false,
      nodeChanges: [],
      edgeChanges: [],
    });
  });

  it("normalizes undefined object fields to JSON-wire absence", () => {
    const base = graph([
      node("wire", {
        data: {
          label: "Wire",
          type: "action",
          config: { optional: undefined },
        },
      }),
    ]);
    const draft = graph([
      node("wire", {
        data: {
          label: "Wire",
          type: "action",
          config: {},
        },
      }),
    ]);

    expect(diffWorkflowGraphs(base, draft).hasChanges).toBe(false);
  });

  it("treats a stored enabled: true as the default on state", () => {
    const omitted = graph([node("action")]);
    const storedOn = withStoredEnabled(omitted, "action", true);
    const storedOff = withStoredEnabled(omitted, "action", false);

    expect(diffWorkflowGraphs(omitted, storedOn)).toEqual({
      hasChanges: false,
      nodeChanges: [],
      edgeChanges: [],
    });
    expect(diffWorkflowGraphs(storedOn, omitted)).toEqual({
      hasChanges: false,
      nodeChanges: [],
      edgeChanges: [],
    });
    expect(
      diffWorkflowGraphs(omitted, storedOff).nodeChanges[0]?.fields
    ).toEqual([{ path: ["data", "enabled"], kind: "added", after: false }]);
    expect(
      diffWorkflowGraphs(storedOn, storedOff).nodeChanges[0]?.fields
    ).toEqual([{ path: ["data", "enabled"], kind: "added", after: false }]);
  });

  it("returns JSON-safe values for non-JSON in-process config values", () => {
    const base = graph([
      node("wire", {
        data: {
          label: "Wire",
          type: "action",
          config: { timestamp: new Date("2026-01-01T00:00:00.000Z") },
        },
      }),
    ]);
    const draft = graph([
      node("wire", {
        data: {
          label: "Wire",
          type: "action",
          config: { timestamp: new Date("2026-01-02T00:00:00.000Z") },
        },
      }),
    ]);

    expect(diffWorkflowGraphs(base, draft).nodeChanges[0]?.fields).toEqual([
      {
        path: ["data", "config", "timestamp"],
        kind: "modified",
        before: "2026-01-01T00:00:00.000Z",
        after: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  describe("test payloads on the entry node", () => {
    function lifecycleGraph(config: Record<string, unknown>) {
      return graph([
        node("lifecycle", {
          type: "lifecycle",
          data: { label: "Lifecycle", type: "lifecycle", config },
        }),
      ]);
    }

    it("counts a draft that only stored a test payload as unchanged", () => {
      const published = lifecycleGraph({});
      const draft = lifecycleGraph({
        testPayloads: {
          manual: { patientId: "pat_1" },
          byEvent: { "app/appointment.created": { id: "apt_1" } },
        },
      });

      expect(diffWorkflowGraphs(published, draft)).toEqual({
        hasChanges: false,
        nodeChanges: [],
        edgeChanges: [],
      });
      expect(semanticWorkflowGraphsEqual(published, draft)).toBe(true);
      expect(graphDigest(draft)).toBe(graphDigest(published));
      expect(draftDiffersFromPublished(draft, published)).toBe(false);
    });

    it("reports a real config change beside a test payload change", () => {
      const published = lifecycleGraph({
        lifecycleRules: {
          ...emptyLifecycleRules,
          allowManualStart: false,
        },
        testPayloads: { manual: { patientId: "pat_1" } },
      });
      const draft = lifecycleGraph({
        lifecycleRules: {
          ...emptyLifecycleRules,
          allowManualStart: true,
        },
        testPayloads: { manual: { patientId: "pat_2" } },
      });

      expect(diffWorkflowGraphs(published, draft).nodeChanges).toEqual([
        {
          nodeId: "lifecycle",
          kind: "modified",
          fields: [
            {
              path: ["data", "config", "lifecycleRules", "allowManualStart"],
              kind: "modified",
              before: false,
              after: true,
            },
          ],
        },
      ]);
      expect(semanticWorkflowGraphsEqual(published, draft)).toBe(false);
      expect(draftDiffersFromPublished(draft, published)).toBe(true);
    });
  });
});

/**
 * The server's diff of two graphs, classified the way every Changes surface
 * reads it: whether the comparison touches Organization and Behavior, and the
 * categories of each changed node by id.
 */
function classifiedDiff(
  base: SerializedWorkflowGraph,
  draft: SerializedWorkflowGraph
) {
  const diff = diffWorkflowGraphs(base, draft);
  const categories = classifyWorkflowComparison({
    baseGraph: base,
    draftGraph: draft,
    nodeChanges: diff.nodeChanges,
    edgeChanges: diff.edgeChanges,
  });
  return {
    diff,
    organization: categories.organization,
    behavior: categories.behavior,
    groupFrameIds: [...categories.groupFrameIds],
    nodes: Object.fromEntries(categories.nodes),
  };
}

describe("classifying a Group comparison", () => {
  const ORGANIZATION = { organization: true, behavior: false };
  const BEHAVIOR = { organization: false, behavior: true };
  const edges: WorkflowEdge[] = [
    { id: "a-b", source: "a", target: "b" },
    { id: "b-c", source: "b", target: "c" },
  ];
  function frame(
    id: string,
    data: { label?: string; description?: string } = {}
  ): WorkflowNode {
    return {
      id,
      type: "group",
      position: { x: 0, y: 0 },
      data: {
        label: data.label ?? "Outreach",
        type: "group",
        description: data.description ?? "vertical",
      },
    };
  }
  const member = (id: string, groupId = "group") =>
    node(id, { parentId: groupId });
  const ungrouped = graph([node("a"), node("b"), node("c")], edges);
  const grouped = graph(
    [frame("group"), member("a"), member("b"), node("c")],
    edges
  );

  it("classifies an added Group and its new members as Organization only", () => {
    const result = classifiedDiff(ungrouped, grouped);

    expect(result.diff.edgeChanges).toEqual([]);
    expect(result).toMatchObject({
      organization: true,
      behavior: false,
      groupFrameIds: ["group"],
      nodes: { a: ORGANIZATION, b: ORGANIZATION, group: ORGANIZATION },
    });
  });

  it("classifies a removed Group and its released members as Organization only", () => {
    const result = classifiedDiff(grouped, ungrouped);

    expect(
      result.diff.nodeChanges.map(({ nodeId, kind }) => [nodeId, kind])
    ).toEqual([
      ["a", "modified"],
      ["b", "modified"],
      ["group", "removed"],
    ]);
    expect(result).toMatchObject({
      organization: true,
      behavior: false,
      nodes: { a: ORGANIZATION, b: ORGANIZATION, group: ORGANIZATION },
    });
  });

  it("classifies a renamed Group as Organization only", () => {
    const renamed = graph(
      [
        frame("group", { label: "Follow-up" }),
        member("a"),
        member("b"),
        node("c"),
      ],
      edges
    );
    const result = classifiedDiff(grouped, renamed);

    expect(result.diff.nodeChanges).toEqual([
      {
        nodeId: "group",
        kind: "modified",
        fields: [
          {
            path: ["data", "label"],
            kind: "modified",
            before: "Outreach",
            after: "Follow-up",
          },
        ],
      },
    ]);
    expect(result).toMatchObject({
      organization: true,
      behavior: false,
      nodes: { group: ORGANIZATION },
    });
  });

  it("classifies a step moved between Groups as Organization only", () => {
    const twoGroups = (cGroup: string) =>
      graph(
        [
          frame("group"),
          frame("other", { label: "Reminders" }),
          member("a"),
          member("b"),
          member("c", cGroup),
          member("d", "other"),
        ],
        edges
      );
    const result = classifiedDiff(twoGroups("group"), twoGroups("other"));

    expect(result.diff.nodeChanges).toEqual([
      {
        nodeId: "c",
        kind: "modified",
        fields: [
          {
            path: ["parentId"],
            kind: "modified",
            before: "group",
            after: "other",
          },
        ],
      },
    ]);
    expect(result).toMatchObject({
      organization: true,
      behavior: false,
      groupFrameIds: [],
      nodes: { c: ORGANIZATION },
    });
  });

  it("classifies a turned Group description as Organization only", () => {
    const horizontal = graph(
      [
        frame("group", { description: "horizontal" }),
        member("a"),
        member("b"),
        node("c"),
      ],
      edges
    );
    const result = classifiedDiff(grouped, horizontal);

    expect(
      result.diff.nodeChanges[0]?.fields.map((field) => field.path)
    ).toEqual([["data", "description"]]);
    expect(result).toMatchObject({
      organization: true,
      behavior: false,
      nodes: { group: ORGANIZATION },
    });
  });

  it("separates Organization from Behavior in a mixed comparison", () => {
    const mixed = graph(
      [
        frame("group", { label: "Follow-up" }),
        member("a"),
        node("b"),
        node("c", {
          parentId: "group",
          data: {
            label: "c",
            type: "action",
            config: { actionType: "example/send", nested: { value: "edited" } },
          },
        }),
        member("added"),
      ],
      [...edges, { id: "c-added", source: "c", target: "added" }]
    );
    const disabledA = withStoredEnabled(mixed, "a", false);
    const result = classifiedDiff(grouped, disabledA);

    expect(result).toMatchObject({
      organization: true,
      behavior: true,
      groupFrameIds: ["group"],
      nodes: {
        a: BEHAVIOR,
        added: BEHAVIOR,
        b: ORGANIZATION,
        c: { organization: true, behavior: true },
        group: ORGANIZATION,
      },
    });
    expect(result.diff.edgeChanges).toEqual([
      { edgeId: "c-added", kind: "added" },
    ]);
  });

  it("keeps selection, visibility, and viewport out of the comparison", () => {
    const sessionState = { selected: true, dragging: true, hidden: true };
    const draft: SerializedWorkflowGraph = {
      ...grouped,
      attributes: { viewport: { x: 40, y: 80, zoom: 2 } },
      nodes: grouped.nodes.map((serialized) => ({
        ...serialized,
        attributes: { ...serialized.attributes, ...sessionState },
      })),
    };

    expect(classifiedDiff(grouped, draft)).toMatchObject({
      diff: { hasChanges: false },
      organization: false,
      behavior: false,
    });
  });
});
