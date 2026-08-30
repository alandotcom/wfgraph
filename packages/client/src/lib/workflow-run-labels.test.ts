import { describe, expect, it } from "vitest";
import {
  NOTHING_PUBLISHED_LABEL,
  publishedModeChoice,
  publishedModeWord,
  publishedRunLabel,
  runGraphLabel,
  runGraphRecipientsLabel,
  runOverlayCopy,
  runRecipientsLabel,
  runSendsLabel,
  runCommandLabel,
  workflowRunTarget,
} from "#src/lib/workflow-run-labels";

/**
 * These cases cover the wording of the two run commands. The draft command
 * always means test recipients. They catch a label that drops the version
 * number or takes the other command's mode.
 */
describe("workflowRunTarget", () => {
  // A draft run reaches test recipients whatever the Published mode is, and it
  // ignores the published version, so the draft arm carries neither field.
  it("returns the draft target whether or not a version is published", () => {
    for (const publishedVersion of [7, undefined]) {
      expect(
        workflowRunTarget({
          graph: "draft",
          workflowMode: "live",
          publishedVersion,
        })
      ).toEqual({ graph: "draft" });
    }
  });

  it("returns null for a published target before the first publish", () => {
    expect(
      workflowRunTarget({
        graph: "published",
        workflowMode: "test",
        publishedVersion: undefined,
      })
    ).toBeNull();
  });
});

describe("runCommandLabel", () => {
  it("labels the draft run without a mode", () => {
    expect(runCommandLabel({ graph: "draft" })).toBe("Run draft");
  });

  it("labels the published run with its version and mode", () => {
    expect(
      runCommandLabel({
        graph: "published",
        publishedVersion: 7,
        workflowMode: "live",
      })
    ).toBe("Run v7 · Live");
    expect(
      runCommandLabel({
        graph: "published",
        publishedVersion: 7,
        workflowMode: "test",
      })
    ).toBe("Run v7 · Test");
  });
});

describe("publishedRunLabel", () => {
  it("gives the reason it is unavailable before the first publish", () => {
    expect(
      publishedRunLabel({ workflowMode: "live", publishedVersion: undefined })
    ).toBe(NOTHING_PUBLISHED_LABEL);
  });

  it("names the version and the mode once a version exists", () => {
    expect(
      publishedRunLabel({ workflowMode: "test", publishedVersion: 12 })
    ).toBe("Run v12 · Test");
  });
});

describe("publishedModeWord", () => {
  it("returns the word for each mode", () => {
    expect(publishedModeWord("live")).toBe("Live");
    expect(publishedModeWord("test")).toBe("Test");
  });
});

describe("publishedModeChoice", () => {
  // Each description is a clause, because the badge beside the control names
  // the version and the menu title names the setting.
  it("describes who each mode reaches", () => {
    expect(publishedModeChoice("live")).toEqual({
      label: "Live",
      description: "Real recipients",
    });
    expect(publishedModeChoice("test")).toEqual({
      label: "Test",
      description: "Test recipients",
    });
  });
});

describe("runSendsLabel", () => {
  it("counts the steps and names the integrations they reach", () => {
    expect(runSendsLabel({ count: 3, integrations: ["Slack", "Resend"] })).toBe(
      "3 steps reach outside this workflow: Slack, Resend"
    );
  });

  it("uses the singular for one step", () => {
    expect(runSendsLabel({ count: 1, integrations: ["Slack"] })).toBe(
      "1 step reaches outside this workflow: Slack"
    );
  });

  // The run dialog leaves the line out at a count of 0, so this phrase is what
  // any other caller gets rather than a sentence about "0 steps".
  it("reports no steps when the graph reaches nothing outside", () => {
    expect(runSendsLabel({ count: 0, integrations: [] })).toBe(
      "No steps reach outside this workflow"
    );
  });
});

describe("runOverlayCopy", () => {
  it("describes the draft run and names no version", () => {
    expect(runOverlayCopy({ graph: "draft" })).toEqual({
      title: "Run draft",
      description: "Runs the draft and sends to test recipients.",
      confirmLabel: "Run draft",
    });
  });

  // The sentence is where the recipients are named, so the heading and the
  // button read the same in both Published modes.
  it("names the real recipients a live published run reaches", () => {
    expect(
      runOverlayCopy({
        graph: "published",
        publishedVersion: 7,
        workflowMode: "live",
      })
    ).toEqual({
      title: "Run v7",
      description: "Runs v7 and sends to real recipients.",
      confirmLabel: "Run v7",
    });
  });

  it("names the test recipients a test published run reaches", () => {
    expect(
      runOverlayCopy({
        graph: "published",
        publishedVersion: 7,
        workflowMode: "test",
      })
    ).toEqual({
      title: "Run v7",
      description: "Runs v7 and sends to test recipients.",
      confirmLabel: "Run v7",
    });
  });
});

describe("runGraphLabel", () => {
  it("labels a draft snapshot run as Draft", () => {
    expect(
      runGraphLabel({ versionKind: "draft_snapshot", versionNumber: null })
    ).toBe("Draft");
  });

  it("labels a published run by its version number, short or qualified", () => {
    const run = { versionKind: "published", versionNumber: 7 } as const;
    expect(runGraphLabel(run)).toBe("v7");
    expect(runGraphLabel(run, "qualified")).toBe("Published v7");
  });

  // The contract rejects a published version without a number, so this covers
  // a row that should never exist.
  it("falls back to Published when a published run carries no number", () => {
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
  it("labels the recipients the run reached", () => {
    expect(runRecipientsLabel("test")).toBe("Test");
    expect(runRecipientsLabel("live")).toBe("Live");
  });
});

describe("runGraphRecipientsLabel", () => {
  it("joins a draft run's graph and recipients into one phrase", () => {
    expect(
      runGraphRecipientsLabel({
        versionKind: "draft_snapshot",
        versionNumber: null,
        runMode: "test",
      })
    ).toBe("Draft · Test");
  });

  it("joins the pinned version and the recipients into one phrase", () => {
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
