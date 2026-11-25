import { describe, expect, it } from "vitest";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type {
  WorkflowComparisonPayload,
  WorkflowNodeChange,
} from "@wfgraph/shared/graph/publication-contracts";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import type { WorkflowIssue } from "@wfgraph/shared/graph/workflow-issues";
import { comparisonFields } from "#src/components/workflow/comparison-properties";
import {
  comparisonSummary,
  describeChangeCounts,
  ORGANIZATION_ONLY_STATEMENT,
} from "#src/lib/workflow-change-summary";
import { buildComparisonDisplayGraph } from "#src/lib/workflow-comparison";
import type { WorkflowComparisonSession } from "#src/lib/workflow-comparison-store";
import {
  changedObjects,
  changesHeaderModel,
  comparisonRevealContext,
  comparisonTitle,
  describeInspection,
  describeMembershipChange,
  describeValidationDifference,
  hasValidationToShow,
  initiallyOpenChangeRows,
  inspectChange,
  issueIdentity,
  nodeValidationSides,
  opensInPlace,
  selectedChangeIndex,
} from "./changes-summary";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [],
  integrations: [],
  actions: [],
};

function step(id: string, label: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label, type: "action" },
  };
}

const payload: WorkflowComparisonPayload = {
  baseVersion: {
    id: "version_3",
    version: 3,
    publishedAt: "2026-09-01T00:00:00.000Z",
    isCurrent: true,
  },
  proposedVersion: 4,
  baseGraph: createSerializedWorkflowGraph({
    nodes: [step("kept", "Kept"), step("gone", "Gone"), step("edited", "Old")],
    edges: [{ id: "kept-gone", source: "kept", target: "gone" }],
  }),
  draftGraph: createSerializedWorkflowGraph({
    nodes: [
      step("kept", "Kept"),
      step("edited", "New"),
      step("fresh", "Fresh"),
    ],
    edges: [{ id: "kept-fresh", source: "kept", target: "fresh" }],
  }),
  hasChanges: true,
  nodeChanges: [
    { nodeId: "fresh", kind: "added", fields: [] },
    { nodeId: "edited", kind: "modified", fields: [] },
    { nodeId: "gone", kind: "removed", fields: [] },
  ],
  edgeChanges: [
    { edgeId: "kept-fresh", kind: "added" },
    { edgeId: "kept-gone", kind: "removed" },
  ],
};

function session(
  base: WorkflowComparisonPayload,
  subview: WorkflowComparisonSession["subview"] = "review"
): WorkflowComparisonSession {
  return {
    payload: base,
    selectedHistoryVersionId: null,
    subview,
    positionOverrides: {},
  };
}

describe("comparisonRevealContext", () => {
  const idleRequest = {
    requestBaseVersionId: null,
    pending: false,
    failed: false,
  };

  it("shows the installed comparison only when it is the one the address names", () => {
    const installed = session(payload);
    expect(
      comparisonRevealContext({
        ...idleRequest,
        baseVersionId: "version_3",
        session: installed,
      })
    ).toEqual({ status: "ready", payload, showsHistory: false });
    expect(
      comparisonRevealContext({
        ...idleRequest,
        baseVersionId: null,
        session: installed,
        pending: true,
      })
    ).toMatchObject({ status: "refreshing", payload });
    expect(
      comparisonRevealContext({
        ...idleRequest,
        baseVersionId: "version_3",
        session: session(payload, "history"),
        requestBaseVersionId: "version_3",
        failed: true,
      })
    ).toMatchObject({ status: "refresh-failed", showsHistory: true });
  });

  it("never presents another base's comparison while the named one loads or fails", () => {
    const installed = session(payload, "history");
    const named = {
      ...idleRequest,
      baseVersionId: "version_1",
      session: installed,
    };
    expect(comparisonRevealContext({ ...named, pending: true })).toEqual({
      status: "loading",
    });
    expect(comparisonRevealContext({ ...named, failed: true })).toEqual({
      status: "error",
    });
    expect(
      comparisonRevealContext({
        ...idleRequest,
        baseVersionId: null,
        session: null,
      })
    ).toEqual({ status: "idle" });
  });

  it("ignores a request for another base than the address names", () => {
    const installed = session(payload);
    const request = { requestBaseVersionId: "version_1" };
    expect(
      comparisonRevealContext({
        ...idleRequest,
        ...request,
        baseVersionId: "version_3",
        session: installed,
        pending: true,
      })
    ).toEqual({ status: "ready", payload, showsHistory: false });
    expect(
      comparisonRevealContext({
        ...idleRequest,
        ...request,
        baseVersionId: "version_3",
        session: installed,
        failed: true,
      })
    ).toMatchObject({ status: "ready" });
    expect(
      comparisonRevealContext({
        ...idleRequest,
        ...request,
        baseVersionId: "version_2",
        session: installed,
        pending: true,
      })
    ).toEqual({ status: "idle" });
  });
});

describe("changesHeaderModel", () => {
  it("names the comparison pair and proposed version, and keeps them while refreshing", () => {
    expect(comparisonTitle(payload)).toBe("Version 3 → proposed version 4");
    expect(
      comparisonTitle({ ...payload, baseVersion: null, proposedVersion: 1 })
    ).toBe("No published version → proposed version 1");

    const refreshing = changesHeaderModel({
      comparison: { status: "refreshing", payload, showsHistory: true },
      workflowName: "Reminders",
    });
    expect(refreshing).toMatchObject({
      workspaceLabel: "Changes",
      title: "Version 3 → proposed version 4",
      path: ["Reminders", "Version 3 → proposed version 4", "Version history"],
      status: { text: "Refreshing", tone: "muted" },
      showsBack: false,
    });
  });

  it("offers no Back and no Focus toggle, since Changes has one level", () => {
    const model = changesHeaderModel({
      comparison: { status: "ready", payload, showsHistory: false },
      workflowName: "Reminders",
    });
    expect(model).toMatchObject({
      title: "Version 3 → proposed version 4",
      path: ["Reminders", "Version 3 → proposed version 4"],
      showsBack: false,
    });
    expect(model.focusToggleText).toBeUndefined();
  });

  it("names what is happening while no comparison is shown", () => {
    const title = (status: "idle" | "loading" | "error") =>
      changesHeaderModel({
        comparison: { status },
        workflowName: "Reminders",
      });
    expect(title("loading")).toMatchObject({
      title: "Comparing changes",
      path: [],
      status: null,
    });
    expect(title("error").title).toBe("Comparison unavailable");
    expect(title("idle").title).toBe("No comparison open");
  });
});

describe("changedObjects", () => {
  it("lists changed steps, then connections by their display edges and step titles", () => {
    const objects = changedObjects({
      payload,
      graph: buildComparisonDisplayGraph(payload),
      catalog,
    });
    expect(
      objects.map(({ key, change, title }) => ({ key, change, title }))
    ).toEqual([
      { key: "node:fresh", change: "added", title: "Fresh" },
      { key: "node:edited", change: "modified", title: "New" },
      { key: "node:gone", change: "removed", title: "Gone" },
      { key: "edge:kept-fresh", change: "added", title: "Kept → Fresh" },
      { key: "edge:kept-gone", change: "removed", title: "Kept → Gone" },
    ]);
  });

  it("finds the selected object by kind and id", () => {
    const objects = changedObjects({
      payload,
      graph: buildComparisonDisplayGraph(payload),
      catalog,
    });
    expect(
      selectedChangeIndex(objects, { nodeIds: [], edgeIds: ["kept-gone"] })
    ).toBe(4);
    expect(
      selectedChangeIndex(objects, { nodeIds: ["edited"], edgeIds: [] })
    ).toBe(1);
    expect(
      selectedChangeIndex(objects, { nodeIds: ["kept"], edgeIds: [] })
    ).toBe(-1);
    expect(
      selectedChangeIndex(objects, { nodeIds: ["fresh", "gone"], edgeIds: [] })
    ).toBe(-1);
  });
});

describe("change list rows", () => {
  const withFields: WorkflowComparisonPayload = {
    ...payload,
    nodeChanges: [
      { nodeId: "fresh", kind: "added", fields: [] },
      {
        nodeId: "edited",
        kind: "modified",
        fields: [
          {
            path: ["data", "label"],
            kind: "modified",
            before: "Old",
            after: "New",
          },
        ],
      },
      { nodeId: "gone", kind: "removed", fields: [] },
    ],
  };
  const objectsOf = (source: WorkflowComparisonPayload) =>
    changedObjects({
      payload: source,
      graph: buildComparisonDisplayGraph(source),
      catalog,
    });

  it("says what changed in each row in words", () => {
    expect(
      objectsOf(withFields).map(({ title, summary }) => ({ title, summary }))
    ).toEqual([
      { title: "Fresh", summary: "Added" },
      { title: "New", summary: "Label changed" },
      { title: "Gone", summary: "Removed" },
      { title: "Kept → Fresh", summary: "Added" },
      { title: "Kept → Gone", summary: "Removed" },
    ]);
    const twoSettings: WorkflowComparisonPayload = {
      ...withFields,
      nodeChanges: [
        {
          nodeId: "edited",
          kind: "modified",
          fields: [
            {
              path: ["data", "label"],
              kind: "modified",
              before: "Old",
              after: "New",
            },
            { path: ["data", "enabled"], kind: "added", after: false },
          ],
        },
      ],
      edgeChanges: [],
    };
    expect(objectsOf(twoSettings).map((item) => item.summary)).toEqual([
      "2 settings changed",
    ]);
  });

  it("opens modified Groups and steps by default and leaves additions, removals and connections closed", () => {
    const objects = objectsOf(withFields);
    expect([...initiallyOpenChangeRows(objects)]).toEqual(["node:edited"]);
    expect(objects.map(opensInPlace)).toEqual([true, true, true, false, false]);
  });

  it("opens only the first modified row in a list of more than eight changed objects", () => {
    const ids = Array.from({ length: 9 }, (_, index) => `step_${index}`);
    const many: WorkflowComparisonPayload = {
      ...payload,
      baseGraph: createSerializedWorkflowGraph({
        nodes: ids.map((id) => step(id, `Old ${id}`)),
        edges: [],
      }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: ids.map((id) => step(id, `New ${id}`)),
        edges: [],
      }),
      nodeChanges: ids.map((id) => ({
        nodeId: id,
        kind: "modified" as const,
        fields: [
          {
            path: ["data", "label"],
            kind: "modified" as const,
            before: `Old ${id}`,
            after: `New ${id}`,
          },
        ],
      })),
      edgeChanges: [],
    };
    expect([...initiallyOpenChangeRows(objectsOf(many))]).toEqual([
      "node:step_0",
    ]);
    expect([
      ...initiallyOpenChangeRows(
        objectsOf({ ...many, nodeChanges: many.nodeChanges.slice(0, 8) })
      ),
    ]).toHaveLength(8);
  });
});

describe("describeChangeCounts", () => {
  it("counts each kind present, in added, modified, removed order", () => {
    expect(describeChangeCounts(payload.nodeChanges)).toBe(
      "1 added, 1 modified, 1 removed"
    );
    expect(
      describeChangeCounts([{ kind: "removed" }, { kind: "removed" }])
    ).toBe("2 removed");
    expect(describeChangeCounts([])).toBe("No changes");
  });
});

describe("inspectChange", () => {
  const graph = buildComparisonDisplayGraph(payload);
  const objects = changedObjects({ payload, graph, catalog });
  const inspect = (object: { kind: "node"; id: string }) =>
    inspectChange({ payload, graph, catalog, objects, nodeId: object.id });

  it("describes added, modified, removed, and unchanged steps by the sides that hold them", () => {
    const sentence = (id: string) => {
      const inspection = inspect({ kind: "node", id });
      if (inspection.kind === "unavailable") {
        throw new Error(`${id} is not on the comparison canvas`);
      }
      return describeInspection(inspection, payload);
    };
    expect(sentence("fresh")).toBe(
      "This step is new in the draft. It is not in version 3, so only the draft's values are shown."
    );
    expect(sentence("gone")).toBe(
      "This step is removed from the draft. Only version 3 has values for it."
    );
    expect(sentence("edited")).toBe(
      "0 settings differ between version 3 and the draft."
    );
    expect(sentence("kept")).toBe(
      "This step's settings are the same in version 3 and the draft. Only its connections changed."
    );
    expect(inspect({ kind: "node", id: "kept" })).toMatchObject({
      change: "unchanged",
      nodeChange: null,
      connections: [{ key: "edge:kept-fresh" }, { key: "edge:kept-gone" }],
    });
  });

  it("calls a node off the canvas unavailable", () => {
    expect(inspect({ kind: "node", id: "missing" })).toEqual({
      kind: "unavailable",
    });
  });
});

describe("describeValidationDifference", () => {
  const issue = (fieldKey: string, nodeLabel = "New"): WorkflowIssue => ({
    kind: "missing_required_field",
    severity: "blocking",
    nodeId: "edited",
    nodeLabel,
    fieldKey,
    fieldLabel: fieldKey,
    message: `Node "${nodeLabel}" is missing required field "${fieldKey}"`,
  });
  const checked = (...issues: WorkflowIssue[]) => ({
    kind: "checked" as const,
    issues,
  });
  const absent = { kind: "absent" as const };
  const unknown = { kind: "unknown" as const };

  it("shows a section only when a version holds an issue or cannot be checked", () => {
    expect(hasValidationToShow({ before: checked(), after: checked() })).toBe(
      false
    );
    expect(hasValidationToShow({ before: absent, after: checked() })).toBe(
      false
    );
    expect(
      hasValidationToShow({
        before: checked(issue("subject")),
        after: checked(),
      })
    ).toBe(true);
    expect(hasValidationToShow({ before: absent, after: unknown })).toBe(true);
  });

  it("counts the issues the draft adds and resolves", () => {
    expect(
      describeValidationDifference({
        before: checked(issue("subject")),
        after: checked(issue("recipient")),
      })
    ).toBe("The draft adds 1 issue and resolves 1 issue.");
    expect(
      describeValidationDifference({ before: checked(), after: checked() })
    ).toBe("No issues in either version.");
    expect(
      describeValidationDifference({
        before: absent,
        after: checked(issue("subject")),
      })
    ).toBe("The draft's step has 1 issue.");
    expect(
      describeValidationDifference({ before: checked(), after: absent })
    ).toBe("The published step had no issues.");
  });

  it("keeps an issue the same when a renamed step changes its message", () => {
    const before = issue("subject", "Old reminder");
    const after = issue("subject", "Reminder");
    expect(issueIdentity(before)).toBe(issueIdentity(after));
    expect(
      describeValidationDifference({
        before: checked(before),
        after: checked(after),
      })
    ).toBe("Validation is the same in both versions.");
  });

  it("says validation is unknown for a side whose action is missing", () => {
    expect(
      describeValidationDifference({ before: unknown, after: checked() })
    ).toBe(
      "Validation of the published step is unknown, because its action is not available in this editor. The draft's step has no issues."
    );
  });
});

describe("nodeValidationSides", () => {
  it("marks a side unknown when its action is missing from the catalog", () => {
    const withAction = (actionType: string): WorkflowNode => ({
      ...step("edited", "Edited"),
      data: { label: "Edited", type: "action", config: { actionType } },
    });
    const sides = nodeValidationSides({
      payload: {
        ...payload,
        baseGraph: createSerializedWorkflowGraph({
          nodes: [withAction("old/removed")],
          edges: [],
        }),
        draftGraph: createSerializedWorkflowGraph({
          nodes: [step("edited", "Edited")],
          edges: [],
        }),
      },
      nodeId: "edited",
      catalog,
    });
    expect(sides.before).toEqual({ kind: "unknown" });
    expect(sides.after.kind).toBe("checked");
  });
});

describe("Group organization in a comparison", () => {
  const frame = (label: string, description: string): WorkflowNode => ({
    id: "group",
    type: "group",
    position: { x: 0, y: 0 },
    data: { label, type: "group", description },
  });
  const inGroup = (node: WorkflowNode): WorkflowNode => ({
    ...node,
    parentId: "group",
  });
  const groupChange: WorkflowNodeChange = {
    nodeId: "group",
    kind: "modified",
    fields: [
      {
        path: ["data", "description"],
        kind: "modified",
        before: "vertical",
        after: "horizontal",
      },
      {
        path: ["data", "label"],
        kind: "modified",
        before: "Reminders",
        after: "Follow-ups",
      },
    ],
  };
  const organizationOnly: WorkflowComparisonPayload = {
    ...payload,
    baseGraph: createSerializedWorkflowGraph({
      nodes: [
        frame("Reminders", "vertical"),
        inGroup(step("inner", "Inner")),
        step("moved", "Moved"),
      ],
      edges: [],
    }),
    draftGraph: createSerializedWorkflowGraph({
      nodes: [
        frame("Follow-ups", "horizontal"),
        inGroup(step("inner", "Inner")),
        inGroup(step("moved", "Moved")),
      ],
      edges: [],
    }),
    nodeChanges: [
      groupChange,
      {
        nodeId: "moved",
        kind: "modified",
        fields: [{ path: ["parentId"], kind: "added", after: "group" }],
      },
    ],
    edgeChanges: [],
  };
  const mixed: WorkflowComparisonPayload = {
    ...organizationOnly,
    nodeChanges: [
      groupChange,
      {
        nodeId: "moved",
        kind: "modified",
        fields: [
          { path: ["data", "enabled"], kind: "added", after: false },
          { path: ["parentId"], kind: "added", after: "group" },
        ],
      },
    ],
    edgeChanges: [{ edgeId: "inner-moved", kind: "added" }],
  };
  const inspectNode = (source: WorkflowComparisonPayload, id: string) => {
    const graph = buildComparisonDisplayGraph(source);
    const objects = changedObjects({ payload: source, graph, catalog });
    const inspection = inspectChange({
      payload: source,
      graph,
      catalog,
      objects,
      nodeId: id,
    });
    if (inspection.kind !== "node") {
      throw new Error(`${id} is not a node on the comparison canvas`);
    }
    return inspection;
  };

  it("states that behavior is unchanged when only Group organization changed", () => {
    expect(comparisonSummary(organizationOnly)).toEqual({
      behavior: null,
      organization: { groups: "1 modified", membership: "1 step changed" },
    });
    expect(ORGANIZATION_ONLY_STATEMENT).toBe(
      "Execution behavior is unchanged. Only how steps are organized in Groups differs."
    );
  });

  it("counts behavior and organization apart in a mixed comparison", () => {
    expect(comparisonSummary(mixed)).toEqual({
      behavior: { steps: "1 modified", connections: "1 added" },
      organization: { groups: "1 modified", membership: "1 step changed" },
    });
    expect(comparisonSummary(payload)).toEqual({
      behavior: {
        steps: "1 added, 1 modified, 1 removed",
        connections: "1 added, 1 removed",
      },
      organization: null,
    });
  });

  it("lists changed Groups first and names a membership-only step by its Group", () => {
    const graph = buildComparisonDisplayGraph(organizationOnly);
    expect(
      changedObjects({ payload: organizationOnly, graph, catalog }).map(
        ({ key, title, summary, groupFrame }) => ({
          key,
          title,
          summary,
          groupFrame,
        })
      )
    ).toEqual([
      {
        key: "node:group",
        title: "Follow-ups",
        summary: "2 settings changed",
        groupFrame: true,
      },
      {
        key: "node:moved",
        title: "Moved",
        summary: "Moved into Follow-ups",
        groupFrame: false,
      },
    ]);
    const mixedObjects = changedObjects({
      payload: mixed,
      graph: buildComparisonDisplayGraph(mixed),
      catalog,
    });
    expect(
      mixedObjects.find((item) => item.key === "node:moved")?.summary
    ).toBe("Enabled changed · Moved into Follow-ups");
  });

  it("describes a Group with its changed steps and says it leaves behavior unchanged", () => {
    const inspection = inspectNode(organizationOnly, "group");
    expect(inspection).toMatchObject({
      groupFrame: true,
      categories: { organization: true, behavior: false },
      membership: null,
      changedMembers: [{ key: "node:moved" }],
    });
    expect(describeInspection(inspection, organizationOnly)).toBe(
      "2 Group settings differ between version 3 and the draft. 1 step inside it changed. Groups only organize steps, so execution behavior is unchanged."
    );
  });

  it("keeps a Group with behavior-changing steps from claiming unchanged behavior", () => {
    const addedWithSteps: WorkflowComparisonPayload = {
      ...payload,
      baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: [frame("Follow-ups", "vertical"), inGroup(step("new", "New"))],
        edges: [],
      }),
      nodeChanges: [
        { nodeId: "group", kind: "added", fields: [] },
        { nodeId: "new", kind: "added", fields: [] },
      ],
      edgeChanges: [],
    };
    expect(
      describeInspection(inspectNode(addedWithSteps, "group"), addedWithSteps)
    ).toBe(
      "This Group is new in the draft. It is not in version 3. 1 step inside it changed. The Group's own change does not affect execution."
    );
    expect(describeInspection(inspectNode(mixed, "group"), mixed)).toBe(
      "2 Group settings differ between version 3 and the draft. 1 step inside it changed. The Group's own change does not affect execution."
    );
  });

  it("names a renamed Group by its published title when a step leaves it", () => {
    const renamedAndLeft: WorkflowComparisonPayload = {
      ...payload,
      baseGraph: createSerializedWorkflowGraph({
        nodes: [
          frame("Old Group", "vertical"),
          inGroup(step("inner", "Inner")),
          inGroup(step("leaving", "Leaving")),
        ],
        edges: [],
      }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: [
          frame("Renamed Group", "vertical"),
          inGroup(step("inner", "Inner")),
          step("leaving", "Leaving"),
        ],
        edges: [],
      }),
      nodeChanges: [
        {
          nodeId: "group",
          kind: "modified",
          fields: [
            {
              path: ["data", "label"],
              kind: "modified",
              before: "Old Group",
              after: "Renamed Group",
            },
          ],
        },
        {
          nodeId: "leaving",
          kind: "modified",
          fields: [{ path: ["parentId"], kind: "removed", before: "group" }],
        },
      ],
      edgeChanges: [],
    };
    const leavingChange = renamedAndLeft.nodeChanges[1];
    if (!leavingChange) {
      throw new Error("the step change is missing");
    }

    const inspection = inspectNode(renamedAndLeft, "leaving");

    expect(inspection.membership).toEqual({ before: "Old Group", after: null });
    expect(describeInspection(inspection, renamedAndLeft)).toBe(
      "It no longer sits in the Group Old Group. Execution behavior is unchanged for this step."
    );
    expect(
      comparisonFields(catalog, renamedAndLeft, leavingChange).map(
        ({ before, after }) => ({ before, after })
      )
    ).toEqual([{ before: "Old Group", after: "Not in a Group" }]);
  });

  it("names the Groups a step moved between in Group words", () => {
    const moved = inspectNode(organizationOnly, "moved");
    expect(moved.membership).toEqual({ before: null, after: "Follow-ups" });
    expect(describeInspection(moved, organizationOnly)).toBe(
      "It now sits in the Group Follow-ups. Execution behavior is unchanged for this step."
    );
    expect(describeInspection(inspectNode(mixed, "moved"), mixed)).toBe(
      "1 setting differs between version 3 and the draft. It now sits in the Group Follow-ups."
    );
    expect(
      describeMembershipChange({ before: "Reminders", after: "Follow-ups" })
    ).toBe("It moved from the Group Reminders to the Group Follow-ups.");
    expect(describeMembershipChange({ before: "Reminders", after: null })).toBe(
      "It no longer sits in the Group Reminders."
    );
  });
});
