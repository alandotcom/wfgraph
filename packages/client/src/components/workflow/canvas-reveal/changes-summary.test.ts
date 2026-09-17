import { describe, expect, it } from "vitest";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import type { WorkflowIssue } from "@wfgraph/shared/graph/workflow-issues";
import { buildComparisonDisplayGraph } from "#src/lib/workflow-comparison";
import type { WorkflowComparisonSession } from "#src/lib/workflow-comparison-store";
import {
  changedObjects,
  changesHeaderModel,
  comparisonRevealContext,
  comparisonTitle,
  describeChangeCounts,
  describeInspection,
  describeValidationDifference,
  inspectChange,
  issueIdentity,
  nodeValidationSides,
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
      level: "browse",
      inspectedTitle: null,
    });
    expect(refreshing).toMatchObject({
      workspaceLabel: "Changes",
      title: "Version 3 → proposed version 4",
      path: ["Reminders", "Version 3 → proposed version 4", "Version history"],
      status: { text: "Refreshing", tone: "muted" },
      showsBack: false,
    });
  });

  it("ends the path with the inspected object at Focus and offers Back", () => {
    expect(
      changesHeaderModel({
        comparison: { status: "ready", payload, showsHistory: false },
        workflowName: "Reminders",
        level: "focus",
        inspectedTitle: "New",
      })
    ).toMatchObject({
      title: "Version 3 → proposed version 4",
      path: ["Reminders", "Version 3 → proposed version 4", "New"],
      showsBack: true,
      focusToggleText: { browse: "Compare fields", focus: "Return to summary" },
    });
  });

  it("names what is happening while no comparison is shown", () => {
    const title = (status: "idle" | "loading" | "error") =>
      changesHeaderModel({
        comparison: { status },
        workflowName: "Reminders",
        level: "browse",
        inspectedTitle: null,
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
  const inspect = (object: { kind: "node" | "edge"; id: string }) =>
    inspectChange({ payload, graph, catalog, objects, object });

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

  it("names a connection by the steps it joins, and an object off the canvas as unavailable", () => {
    expect(inspect({ kind: "edge", id: "kept-gone" })).toMatchObject({
      kind: "edge",
      change: "removed",
      source: "Kept",
      target: "Gone",
      branch: null,
    });
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
