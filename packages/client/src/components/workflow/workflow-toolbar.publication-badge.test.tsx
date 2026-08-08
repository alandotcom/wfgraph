import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkflowPublicationBadge } from "#src/components/workflow/workflow-publication-badge";

describe("WorkflowPublicationBadge", () => {
  it("shows Unpublished changes when the draft differs from published", () => {
    render(
      <WorkflowPublicationBadge
        hasUnpublishedChanges={true}
        isPublished={true}
      />
    );

    expect(screen.getByText("Unpublished changes")).toBeTruthy();
    expect(screen.queryByText("Published")).toBeNull();
  });

  it("shows Published when the draft matches", () => {
    render(
      <WorkflowPublicationBadge
        hasUnpublishedChanges={false}
        isPublished={true}
      />
    );

    expect(screen.getByText("Published")).toBeTruthy();
    expect(screen.queryByText("Unpublished changes")).toBeNull();
  });

  it("shows Never published when there is no published version", () => {
    render(
      <WorkflowPublicationBadge
        hasUnpublishedChanges={false}
        isPublished={false}
      />
    );

    expect(screen.getByText("Never published")).toBeTruthy();
  });
});
