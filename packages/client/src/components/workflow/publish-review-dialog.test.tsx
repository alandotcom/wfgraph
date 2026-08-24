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
  it("presents deterministic structural facts and the Test mode consequence", () => {
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

    expect(
      view.getByRole("dialog", { name: "Publish version 8?" })
    ).toBeTruthy();
    expect(view.getByText("Based on version 7")).toBeTruthy();
    expect(view.getByText("Proposed version 8")).toBeTruthy();
    expect(view.getByText("Added nodes").nextSibling?.textContent).toBe("1");
    expect(view.getByText("Modified nodes").nextSibling?.textContent).toBe("1");
    expect(view.getByText("Removed nodes").nextSibling?.textContent).toBe("1");
    expect(view.getByText("Added connections").nextSibling?.textContent).toBe(
      "1"
    );
    expect(view.getByText("Removed connections").nextSibling?.textContent).toBe(
      "1"
    );
    expect(
      view.getByText("Publishing does not change recipient routing.")
    ).toBeTruthy();
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
