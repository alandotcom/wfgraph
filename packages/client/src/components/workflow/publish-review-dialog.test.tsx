import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  publicationReviewFromComparison,
  PublishReviewDialog,
} from "#src/components/workflow/publish-review-dialog";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";

const comparison: WorkflowComparisonPayload = {
  baseVersion: {
    id: "version_7",
    version: 7,
    publishedAt: "2026-08-23T15:00:00.000Z",
    isCurrent: true,
  },
  proposedVersion: 8,
  baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
  draftGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
  hasChanges: true,
  nodeChanges: [
    { nodeId: "added", kind: "added", fields: [] },
    { nodeId: "modified", kind: "modified", fields: [] },
    { nodeId: "removed", kind: "removed", fields: [] },
  ],
  edgeChanges: [
    { edgeId: "new-connection", kind: "added" },
    { edgeId: "old-connection", kind: "removed" },
  ],
};

function renderDialog(review: WorkflowComparisonPayload) {
  return render(
    <PublishReviewDialog
      review={publicationReviewFromComparison(review)}
      isPublishing={false}
      mode="test"
      onConfirm={vi.fn()}
      onOpenChange={vi.fn()}
      open
    />
  );
}

/** Each label and value row of one summary section, as text. */
function summaryRows(view: ReturnType<typeof render>, name: string) {
  const section = view.getByRole("region", { name });
  return [...section.querySelectorAll("dl > div")].map((row) => [
    row.querySelector("dt")?.textContent,
    row.querySelector("dd")?.textContent,
  ]);
}

const groupFrame = (label: string): WorkflowNode => ({
  id: "group",
  type: "group",
  position: { x: 0, y: 0 },
  data: { label, type: "group" },
});

const step = (id: string): WorkflowNode => ({
  id,
  type: "action",
  position: { x: 0, y: 0 },
  data: { label: id, type: "action" },
});

const inGroup = (node: WorkflowNode): WorkflowNode => ({
  ...node,
  parentId: "group",
});

/** Version 7 against a draft that renames a Group and moves "moved" into it. */
const organizationOnly: WorkflowComparisonPayload = {
  ...comparison,
  baseGraph: createSerializedWorkflowGraph({
    nodes: [groupFrame("Reminders"), inGroup(step("inner")), step("moved")],
    edges: [],
  }),
  draftGraph: createSerializedWorkflowGraph({
    nodes: [
      groupFrame("Follow-ups"),
      inGroup(step("inner")),
      inGroup(step("moved")),
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
          before: "Reminders",
          after: "Follow-ups",
        },
      ],
    },
    {
      nodeId: "moved",
      kind: "modified",
      fields: [{ path: ["parentId"], kind: "added", after: "group" }],
    },
  ],
  edgeChanges: [],
};

describe("PublishReviewDialog", () => {
  it("says an Organization-only publish leaves execution behavior unchanged", () => {
    const view = renderDialog(organizationOnly);

    const behavior = view.getByRole("region", { name: "Behavior changes" });
    expect(behavior.textContent).toContain(
      "Execution behavior is unchanged. Only how steps are organized in Groups differs."
    );
    expect(behavior.querySelector("dl")).toBeNull();
    expect(summaryRows(view, "Organization changes")).toEqual([
      ["Groups", "1 modified"],
      ["Group membership", "1 step changed"],
    ]);
  });

  it("counts Behavior and Organization apart in a mixed publish", () => {
    const view = renderDialog({
      ...organizationOnly,
      nodeChanges: [
        ...organizationOnly.nodeChanges.slice(0, 1),
        {
          nodeId: "moved",
          kind: "modified",
          fields: [
            { path: ["parentId"], kind: "added", after: "group" },
            { path: ["data", "enabled"], kind: "added", after: false },
          ],
        },
      ],
      edgeChanges: [{ edgeId: "inner-moved", kind: "added" }],
    });

    expect(summaryRows(view, "Behavior changes")).toEqual([
      ["Steps", "1 modified"],
      ["Connections", "1 added"],
    ]);
    expect(summaryRows(view, "Organization changes")).toEqual([
      ["Groups", "1 modified"],
      ["Group membership", "1 step changed"],
    ]);
    expect(view.queryByText(/behavior is unchanged/i)).toBeNull();
  });

  it("presents deterministic structural facts and the Published mode consequence", () => {
    const view = render(
      <PublishReviewDialog
        review={publicationReviewFromComparison(comparison)}
        isPublishing={false}
        mode="test"
        onConfirm={vi.fn()}
        onOpenChange={vi.fn()}
        open
      />
    );

    expect(view.getByRole("dialog", { name: "Publish v8?" })).toBeTruthy();
    expect(view.getByText("Based on v7")).toBeTruthy();
    expect(view.getByText("Proposed v8")).toBeTruthy();
    expect(summaryRows(view, "Behavior changes")).toEqual([
      ["Steps", "1 added, 1 modified, 1 removed"],
      ["Connections", "1 added, 1 removed"],
    ]);
    expect(
      view.queryByRole("region", { name: "Organization changes" })
    ).toBeNull();
    const note = view.getByText(
      "Published mode is Test. v8 sends to test recipients until you switch to Live."
    );
    // The sentence stays muted in both modes, because a tinted box here would
    // rank one publish above the other. Amber marks Test on the dot alone, the
    // way the status strip's Published mode control marks it.
    expect(note.className).toContain("text-muted-foreground");
    expect(note.className).not.toContain("border-warning/30");
    expect(note.querySelector("svg")?.getAttribute("class")).toContain(
      "text-warning"
    );
  });

  // The Test note says the version is held back from real recipients. The Live
  // note says it reaches them at once. Both are one muted sentence.
  it("says a Live publish reaches real recipients at once", () => {
    const view = render(
      <PublishReviewDialog
        review={publicationReviewFromComparison(comparison)}
        isPublishing={false}
        mode="live"
        onConfirm={vi.fn()}
        onOpenChange={vi.fn()}
        open
      />
    );

    const note = view.getByText(
      "Published mode is Live. v8 sends to real recipients as soon as you publish."
    );
    expect(note.className).toContain("text-muted-foreground");
    expect(note.className).not.toContain("border-destructive/30");
    // Amber belongs to Test, so the Live dot stays in muted ink.
    expect(note.querySelector("svg")?.getAttribute("class")).not.toContain(
      "text-warning"
    );
    expect(view.queryByText(/Published mode is Test/)).toBeNull();
  });

  it("does not confirm publication when cancelled", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const view = render(
      <PublishReviewDialog
        review={publicationReviewFromComparison(comparison)}
        isPublishing={false}
        mode="live"
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
        open
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Cancel" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
