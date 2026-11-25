import { describe, expect, it } from "vitest";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type {
  WorkflowEdgeChange,
  WorkflowNodeChange,
} from "@wfgraph/shared/graph/publication-contracts";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  editsCountLine,
  workflowEdits,
  type EditsComparison,
} from "./workflow-edits";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [],
  integrations: [],
  actions: [
    {
      id: "mail/send",
      label: "Send email",
      description: "",
      category: "Mail",
      configFields: [{ key: "body", label: "Body", type: "text" }],
      outputFields: [],
    },
  ],
};

let row = 0;

function step(
  id: string,
  label: string,
  options: { parentId?: string; config?: Record<string, unknown> } = {}
): WorkflowNode {
  row += 1;
  return {
    id,
    type: "action",
    position: { x: 0, y: row * 100 },
    ...omitUndefined({ parentId: options.parentId }),
    data: {
      label,
      type: "action",
      config: { actionType: "mail/send", ...options.config },
    },
  };
}

function lifecycle(): WorkflowNode {
  return {
    id: "lifecycle",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "Appointment booked", type: "lifecycle" },
  };
}

function condition(id: string, label: string): WorkflowNode {
  return {
    ...step(id, label),
    data: { label, type: "action", config: { actionType: "Condition" } },
  };
}

function group(id: string, label: string): WorkflowNode {
  return {
    id,
    type: "group",
    position: { x: 400, y: 0 },
    data: { label, type: "group" },
  };
}

function edge(source: string, target: string, sourceHandle?: string) {
  return {
    id: `${source}-${sourceHandle ?? "out"}-${target}`,
    source,
    target,
    ...omitUndefined({ sourceHandle }),
  } satisfies WorkflowEdge;
}

function comparison(input: {
  base: { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  draft: { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  nodeChanges: WorkflowNodeChange[];
  edgeChanges: WorkflowEdgeChange[];
}): EditsComparison {
  return {
    baseGraph: createSerializedWorkflowGraph(input.base),
    draftGraph: createSerializedWorkflowGraph(input.draft),
    nodeChanges: input.nodeChanges,
    edgeChanges: input.edgeChanges,
  };
}

const started = (target: string) => edge("lifecycle", target, "started");

describe("workflowEdits", () => {
  it("names a new workflow's start Start and calls it added, never a new step", () => {
    const start: WorkflowNode = {
      id: "lifecycle",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: { label: "", type: "lifecycle", config: {} },
    };
    const edits = workflowEdits(
      comparison({
        base: { nodes: [], edges: [] },
        draft: {
          nodes: [start, step("send", "Send welcome")],
          edges: [started("send")],
        },
        nodeChanges: [
          { nodeId: "lifecycle", kind: "added", fields: [] },
          { nodeId: "send", kind: "added", fields: [] },
        ],
        edgeChanges: [{ edgeId: "lifecycle-started-send", kind: "added" }],
      }),
      catalog
    );

    expect(edits.edits.map(({ title, summary }) => [title, summary])).toEqual([
      ["Start", "Added"],
      ["Send welcome", "New step"],
    ]);
  });

  it("reads the seeded comparison's six changes as three edits and one organization change", () => {
    const shared = [
      lifecycle(),
      condition("covers", "Deposit covers the visit?"),
      step("receipt", "Send deposit receipt"),
      step("release", "Release the slot"),
      step("desk", "Alert the front desk"),
      step("wait24", "Wait until 24 hours before", { parentId: "reminders" }),
      step("wait2", "Wait until 2 hours before", { parentId: "reminders" }),
    ];
    const sharedEdges = [
      started("covers"),
      edge("covers", "receipt", "true"),
      edge("covers", "release", "false"),
      edge("release", "desk"),
      edge("wait24", "remind"),
      edge("remind", "wait2"),
    ];
    const reminder = (body: string) =>
      step("remind", "Send 24-hour reminder", {
        parentId: "reminders",
        config: { body },
      });
    const edits = workflowEdits(
      comparison({
        base: {
          nodes: [
            group("reminders", "Reminder sequence"),
            ...shared,
            reminder("See you on Monday."),
            step("billing", "Email the billing team"),
          ],
          edges: [...sharedEdges, edge("desk", "billing")],
        },
        draft: {
          nodes: [
            group("reminders", "Pre-visit reminders"),
            ...shared,
            reminder("See you tomorrow."),
            step("intake", "Send intake form"),
          ],
          edges: [...sharedEdges, edge("receipt", "intake")],
        },
        nodeChanges: [
          {
            nodeId: "reminders",
            kind: "modified",
            fields: [
              {
                path: ["data", "label"],
                kind: "modified",
                before: "Reminder sequence",
                after: "Pre-visit reminders",
              },
            ],
          },
          {
            nodeId: "remind",
            kind: "modified",
            fields: [
              {
                path: ["data", "config", "body"],
                kind: "modified",
                before: "See you on Monday.",
                after: "See you tomorrow.",
              },
            ],
          },
          { nodeId: "intake", kind: "added", fields: [] },
          { nodeId: "billing", kind: "removed", fields: [] },
        ],
        edgeChanges: [
          { edgeId: "receipt-out-intake", kind: "added" },
          { edgeId: "desk-out-billing", kind: "removed" },
        ],
      }),
      catalog
    );

    expect(
      edits.edits.map(({ kind, title, summary, strip }) => ({
        kind,
        title,
        summary,
        strip: {
          group: strip.group,
          before: strip.before.map((item) => [item.label, item.branch]),
          after: strip.after.map((item) => [item.label, item.branch]),
        },
      }))
    ).toEqual([
      {
        kind: "added",
        title: "Send intake form",
        summary: "New step",
        strip: {
          group: null,
          before: [["Send deposit receipt", null]],
          after: [],
        },
      },
      {
        kind: "removed",
        title: "Email the billing team",
        summary: "Removed",
        strip: {
          group: null,
          before: [["Alert the front desk", null]],
          after: [],
        },
      },
      {
        kind: "modified",
        title: "Send 24-hour reminder",
        summary: "Body changed",
        strip: {
          group: "Pre-visit reminders",
          before: [["Wait until 24 hours before", null]],
          after: [["Wait until 2 hours before", null]],
        },
      },
    ]);
    expect(edits.organization.map((item) => item.text)).toEqual([
      'Group "Reminder sequence" renamed to "Pre-visit reminders"',
    ]);
    expect(editsCountLine(edits)).toBe("3 edits change what runs. 1 does not.");
  });

  it("reads a pure rewire as the step that now continues elsewhere", () => {
    const nodes = [lifecycle(), step("a", "A"), step("b", "B"), step("c", "C")];
    const edits = workflowEdits(
      comparison({
        base: { nodes, edges: [started("a"), edge("a", "b")] },
        draft: { nodes, edges: [started("a"), edge("a", "c")] },
        nodeChanges: [],
        edgeChanges: [
          { edgeId: "a-out-c", kind: "added" },
          { edgeId: "a-out-b", kind: "removed" },
        ],
      }),
      catalog
    );

    expect(edits.edits).toHaveLength(1);
    expect(edits.edits[0]).toMatchObject({
      kind: "modified",
      nodeId: "a",
      title: "A",
      summary: "Now continues to C",
      nodeChange: null,
      rewires: [{ branch: null, to: ["C"], from: ["B"] }],
    });
    expect(edits.organization).toEqual([]);
  });

  it("names the branch of a rewired Condition outlet", () => {
    const nodes = [lifecycle(), condition("if", "Paid?"), step("b", "B")];
    const edits = workflowEdits(
      comparison({
        base: { nodes, edges: [started("if")] },
        draft: { nodes, edges: [started("if"), edge("if", "b", "false")] },
        nodeChanges: [],
        edgeChanges: [{ edgeId: "if-false-b", kind: "added" }],
      }),
      catalog
    );

    expect(edits.edits.map((edit) => edit.summary)).toEqual([
      "On False, now continues to B",
    ]);
  });

  it("names the Group of a step added inside it and absorbs its connections", () => {
    const frame = group("g", "Follow-ups");
    const first = step("first", "First", { parentId: "g" });
    const last = step("last", "Last", { parentId: "g" });
    const fresh = step("fresh", "Fresh", { parentId: "g" });
    const edits = workflowEdits(
      comparison({
        base: {
          nodes: [lifecycle(), frame, first, last],
          edges: [started("first"), edge("first", "last")],
        },
        draft: {
          nodes: [lifecycle(), frame, first, fresh, last],
          edges: [
            started("first"),
            edge("first", "fresh"),
            edge("fresh", "last"),
          ],
        },
        nodeChanges: [{ nodeId: "fresh", kind: "added", fields: [] }],
        edgeChanges: [
          { edgeId: "first-out-fresh", kind: "added" },
          { edgeId: "fresh-out-last", kind: "added" },
          { edgeId: "first-out-last", kind: "removed" },
        ],
      }),
      catalog
    );

    expect(edits.edits).toHaveLength(1);
    expect(edits.edits[0]?.strip).toEqual({
      group: "Follow-ups",
      before: [{ nodeId: "first", label: "First", branch: null }],
      after: [{ nodeId: "last", label: "Last", branch: null }],
    });
    expect(edits.organization).toEqual([]);
  });

  it("names the branch a step added on a Condition branch follows", () => {
    const nodes = [lifecycle(), condition("if", "Paid?")];
    const fresh = step("fresh", "Send thanks");
    const edits = workflowEdits(
      comparison({
        base: { nodes, edges: [started("if")] },
        draft: {
          nodes: [...nodes, fresh],
          edges: [started("if"), edge("if", "fresh", "true")],
        },
        nodeChanges: [{ nodeId: "fresh", kind: "added", fields: [] }],
        edgeChanges: [{ edgeId: "if-true-fresh", kind: "added" }],
      }),
      catalog
    );

    expect(edits.edits).toHaveLength(1);
    expect(edits.edits[0]).toMatchObject({
      kind: "added",
      summary: "New step",
      strip: {
        before: [{ label: "Paid?", branch: "True" }],
        after: [],
      },
    });
  });

  it("reads a step removed from the middle of a path as one edit", () => {
    const a = step("a", "A");
    const gone = step("gone", "Gone");
    const b = step("b", "B");
    const edits = workflowEdits(
      comparison({
        base: {
          nodes: [lifecycle(), a, gone, b],
          edges: [started("a"), edge("a", "gone"), edge("gone", "b")],
        },
        draft: {
          nodes: [lifecycle(), a, b],
          edges: [started("a"), edge("a", "b")],
        },
        nodeChanges: [{ nodeId: "gone", kind: "removed", fields: [] }],
        edgeChanges: [
          { edgeId: "a-out-b", kind: "added" },
          { edgeId: "a-out-gone", kind: "removed" },
          { edgeId: "gone-out-b", kind: "removed" },
        ],
      }),
      catalog
    );

    expect(edits.edits).toHaveLength(1);
    expect(edits.edits[0]).toMatchObject({
      kind: "removed",
      title: "Gone",
      summary: "Removed",
      strip: {
        before: [{ label: "A" }],
        after: [{ label: "B" }],
      },
    });
  });

  it("lists a Group-only change apart and counts no edit", () => {
    const frame = (label: string) => group("g", label);
    const member = step("m", "Member", { parentId: "g" });
    const edits = workflowEdits(
      comparison({
        base: { nodes: [lifecycle(), frame("Old"), member], edges: [] },
        draft: { nodes: [lifecycle(), frame("New"), member], edges: [] },
        nodeChanges: [
          {
            nodeId: "g",
            kind: "modified",
            fields: [
              {
                path: ["data", "description"],
                kind: "added",
                after: "Reminders",
              },
            ],
          },
        ],
        edgeChanges: [],
      }),
      catalog
    );

    expect(edits.edits).toEqual([]);
    expect(edits.organization.map((item) => item.text)).toEqual([
      'Group "New" description changed',
    ]);
    expect(editsCountLine(edits)).toBe(
      "No edit changes what runs. 1 does not."
    );
  });

  it("lists a step that only moved into a Group apart", () => {
    const member = (parentId?: string) =>
      step("m", "Member", parentId === undefined ? {} : { parentId });
    const edits = workflowEdits(
      comparison({
        base: { nodes: [lifecycle(), member()], edges: [] },
        draft: {
          nodes: [lifecycle(), group("g", "Follow-ups"), member("g")],
          edges: [],
        },
        nodeChanges: [
          { nodeId: "g", kind: "added", fields: [] },
          {
            nodeId: "m",
            kind: "modified",
            fields: [{ path: ["parentId"], kind: "added", after: "g" }],
          },
        ],
        edgeChanges: [],
      }),
      catalog
    );

    expect(edits.edits).toEqual([]);
    expect(edits.organization.map((item) => item.text)).toEqual([
      'New Group "Follow-ups"',
      '"Member" moved into "Follow-ups"',
    ]);
  });

  it("names a step whose action is missing without its internal id", () => {
    const hidden: WorkflowNode = {
      id: "hidden",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "  ",
        type: "action",
        config: { actionType: "private/internal-action" },
      },
    };
    const edits = workflowEdits(
      comparison({
        base: { nodes: [lifecycle()], edges: [] },
        draft: { nodes: [lifecycle(), hidden], edges: [] },
        nodeChanges: [{ nodeId: "hidden", kind: "added", fields: [] }],
        edgeChanges: [],
      }),
      catalog
    );

    expect(edits.edits.map((edit) => edit.title)).toEqual([
      "Unavailable action",
    ]);
  });
});
