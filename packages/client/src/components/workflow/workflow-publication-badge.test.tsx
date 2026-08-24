/**
 * The badge's three states through props, which is what it was split out of the
 * strip to make possible.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  publicationLabel,
  WorkflowPublicationBadge,
} from "#src/components/workflow/workflow-publication-badge";

describe("WorkflowPublicationBadge", () => {
  it("shows Unpublished changes when the draft differs from published", () => {
    render(
      <WorkflowPublicationBadge
        hasUnpublishedChanges={true}
        isPublished={true}
      />
    );

    expect(screen.getByText("Unpublished changes")).toBeTruthy();
  });

  it("shows Published when the draft matches", () => {
    render(
      <WorkflowPublicationBadge
        hasUnpublishedChanges={false}
        isPublished={true}
      />
    );

    expect(screen.getByText("Published")).toBeTruthy();
  });

  it("includes the current version when it is available", () => {
    expect(
      publicationLabel({
        isPublished: true,
        hasUnpublishedChanges: true,
        publishedVersion: 7,
      })
    ).toBe("Unpublished changes since version 7");
    expect(
      publicationLabel({
        isPublished: true,
        hasUnpublishedChanges: false,
        publishedVersion: 7,
      })
    ).toBe("Published version 7");
  });

  it("shows Never published before the first publish", () => {
    render(
      <WorkflowPublicationBadge
        hasUnpublishedChanges={false}
        isPublished={false}
      />
    );

    expect(screen.getByText("Never published")).toBeTruthy();
  });
});

describe("publicationLabel", () => {
  it("ignores the draft comparison until something has been published", () => {
    // The server answers `hasUnpublishedChanges: false` for a workflow that has
    // never been published, and a badge that read that field first would call
    // an unpublished draft "Published".
    expect(
      publicationLabel({ isPublished: false, hasUnpublishedChanges: true })
    ).toBe("Never published");
    expect(
      publicationLabel({ isPublished: false, hasUnpublishedChanges: false })
    ).toBe("Never published");
  });

  it("never says Live, which the mode label a few pixels away owns", () => {
    // The strip prints publication and mode on one line, so a second meaning
    // for "Live" would read as one switch with two labels.
    for (const isPublished of [true, false]) {
      for (const hasUnpublishedChanges of [true, false]) {
        expect(
          publicationLabel({ isPublished, hasUnpublishedChanges })
        ).not.toContain("Live");
      }
    }
  });
});
