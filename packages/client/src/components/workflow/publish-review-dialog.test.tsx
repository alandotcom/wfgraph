import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  publicationReviewFromComparison,
  PublishReviewDialog,
} from "#src/components/workflow/publish-review-dialog";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";

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

describe("PublishReviewDialog", () => {
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
    expect(view.getByText("Added nodes").nextSibling?.textContent).toBe("1");
    expect(view.getByText("Modified nodes").nextSibling?.textContent).toBe("1");
    expect(view.getByText("Removed nodes").nextSibling?.textContent).toBe("1");
    expect(view.getByText("Added connections").nextSibling?.textContent).toBe(
      "1"
    );
    expect(view.getByText("Removed connections").nextSibling?.textContent).toBe(
      "1"
    );
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
