import { describe, expect, it } from "vitest";
import {
  NOTHING_PUBLISHED_LABEL,
  publishedModeChoice,
  publishedModeLabel,
  publishedRunLabel,
  runGraphLabel,
  runGraphRecipientsLabel,
  runOverlayCopy,
  runRecipientsLabel,
  runVerbLabel,
  workflowRunTarget,
} from "#src/lib/workflow-run-labels";

/**
 * The vocabulary is the feature here: two verbs the operator picks between, one
 * of which always means test recipients. A label that drops the version number
 * or borrows the other verb's mode is the defect these cases exist to catch.
 */
describe("workflowRunTarget", () => {
  it("names the draft with the version that keeps handling Events", () => {
    expect(
      workflowRunTarget({
        graph: "draft",
        workflowMode: "live",
        publishedVersion: 7,
      })
    ).toEqual({ graph: "draft", publishedVersion: 7 });
  });

  // A draft run goes to test recipients whatever the workflow's Published mode
  // is, so the mode is not on that arm of the target at all.
  it("leaves Published mode off a draft run", () => {
    expect(
      workflowRunTarget({
        graph: "draft",
        workflowMode: "live",
        publishedVersion: undefined,
      })
    ).toEqual({ graph: "draft" });
  });

  it("has no published target before the first publish", () => {
    expect(
      workflowRunTarget({
        graph: "published",
        workflowMode: "test",
        publishedVersion: undefined,
      })
    ).toBeNull();
  });
});

describe("runVerbLabel", () => {
  it("names the draft without a mode", () => {
    expect(runVerbLabel({ graph: "draft", publishedVersion: 7 })).toBe(
      "Run draft"
    );
  });

  it("suffixes the published run with the mode it honours", () => {
    expect(
      runVerbLabel({
        graph: "published",
        publishedVersion: 7,
        workflowMode: "live",
      })
    ).toBe("Run v7 · Live");
    expect(
      runVerbLabel({
        graph: "published",
        publishedVersion: 7,
        workflowMode: "test",
      })
    ).toBe("Run v7 · Test");
  });
});

describe("publishedRunLabel", () => {
  it("says why it is unavailable before the first publish", () => {
    expect(
      publishedRunLabel({ workflowMode: "live", publishedVersion: undefined })
    ).toBe(NOTHING_PUBLISHED_LABEL);
  });

  it("names the version and the mode once there is one", () => {
    expect(
      publishedRunLabel({ workflowMode: "test", publishedVersion: 12 })
    ).toBe("Run v12 · Test");
  });
});

describe("publishedModeLabel", () => {
  it("carries the version the mode applies to", () => {
    expect(
      publishedModeLabel({ workflowMode: "test", publishedVersion: 7 })
    ).toBe("v7 · Test");
  });

  // Nothing is published, so there is no version for the mode to describe yet.
  it("drops the number until the first publish", () => {
    expect(
      publishedModeLabel({ workflowMode: "live", publishedVersion: undefined })
    ).toBe("Live");
  });
});

describe("publishedModeChoice", () => {
  it("says where each mode sends, naming the version", () => {
    expect(
      publishedModeChoice({ workflowMode: "live", publishedVersion: 7 })
    ).toEqual({
      label: "Live",
      description: "Events and manual runs of v7 send to real recipients.",
    });
    expect(
      publishedModeChoice({ workflowMode: "test", publishedVersion: 7 })
        .description
    ).toBe(
      "Events and manual runs of v7 go to test recipients. Running the draft never needs this."
    );
  });

  it("says when the setting starts to matter before the first publish", () => {
    expect(
      publishedModeChoice({ workflowMode: "live", publishedVersion: undefined })
        .description
    ).toBe(
      "Events and manual runs of the published version send to real recipients. Takes effect on publish."
    );
  });
});

describe("runOverlayCopy", () => {
  it("tells a draft run what stays live while it runs", () => {
    expect(runOverlayCopy({ graph: "draft", publishedVersion: 7 })).toEqual({
      title: "Run draft",
      description:
        "Runs the draft on this canvas with test recipients. Published v7 keeps handling Events.",
      confirmLabel: "Run draft",
    });
  });

  it("says only what the draft run does when nothing is published", () => {
    expect(runOverlayCopy({ graph: "draft" }).description).toBe(
      "Runs the draft on this canvas with test recipients."
    );
  });

  it("warns a live published run where it sends", () => {
    expect(
      runOverlayCopy({
        graph: "published",
        publishedVersion: 7,
        workflowMode: "live",
      })
    ).toEqual({
      title: "Run v7 · Live",
      description:
        "Runs Published v7 and sends to real recipients. Draft edits are not included.",
      confirmLabel: "Run v7 · Live",
    });
  });

  it("keeps a test published run's recipients in its sentence", () => {
    expect(
      runOverlayCopy({
        graph: "published",
        publishedVersion: 7,
        workflowMode: "test",
      }).description
    ).toBe(
      "Runs Published v7 with test recipients. Draft edits are not included."
    );
  });
});

describe("runGraphLabel", () => {
  it("names a snapshot run after the canvas it froze", () => {
    expect(
      runGraphLabel({ versionKind: "draft_snapshot", versionNumber: null })
    ).toBe("Draft");
  });

  it("names a published run by its number, tersely or in prose", () => {
    const run = { versionKind: "published", versionNumber: 7 } as const;
    expect(runGraphLabel(run)).toBe("v7");
    expect(runGraphLabel(run, "qualified")).toBe("Published v7");
  });

  // The contract refuses a published version without a number, so this is the
  // one reading every surface gives the case none of them can produce.
  it("falls back to the bare word when a published run carries no number", () => {
    expect(
      runGraphLabel({ versionKind: "published", versionNumber: null })
    ).toBe("Published");
    expect(
      runGraphLabel(
        { versionKind: "published", versionNumber: null },
        "qualified"
      )
    ).toBe("Published");
  });
});

describe("runRecipientsLabel", () => {
  it("says who the run reached", () => {
    expect(runRecipientsLabel("test")).toBe("Test");
    expect(runRecipientsLabel("live")).toBe("Live");
  });
});

describe("runGraphRecipientsLabel", () => {
  it("puts a draft run's graph and recipients in one phrase", () => {
    expect(
      runGraphRecipientsLabel({
        versionKind: "draft_snapshot",
        versionNumber: null,
        runMode: "test",
      })
    ).toBe("Draft · Test");
  });

  it("names the published version a run pinned beside its recipients", () => {
    expect(
      runGraphRecipientsLabel({
        versionKind: "published",
        versionNumber: 7,
        runMode: "live",
      })
    ).toBe("v7 · Live");
    expect(
      runGraphRecipientsLabel({
        versionKind: "published",
        versionNumber: 7,
        runMode: "test",
      })
    ).toBe("v7 · Test");
  });
});
