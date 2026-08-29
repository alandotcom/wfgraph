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
  runVerbLabel,
  workflowRunTarget,
} from "#src/lib/workflow-run-labels";

/**
 * The vocabulary is the feature here: two verbs the operator picks between, one
 * of which always means test recipients. A label that drops the version number
 * or borrows the other verb's mode is the defect these cases exist to catch.
 */
describe("workflowRunTarget", () => {
  // A draft run goes to test recipients whatever the workflow's Published mode
  // is, and it says nothing about the published version, so neither is on that
  // arm of the target at all.
  it("names the draft alone, published version or not", () => {
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
    expect(runVerbLabel({ graph: "draft" })).toBe("Run draft");
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

describe("publishedModeWord", () => {
  it("names the mode the control wears", () => {
    expect(publishedModeWord("live")).toBe("Live");
    expect(publishedModeWord("test")).toBe("Test");
  });
});

describe("publishedModeChoice", () => {
  // One clause each: the badge beside the control already names the version,
  // and the menu's own title says the setting is about the published version.
  it("says who each mode reaches, in a clause", () => {
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
  it("counts the sends and names the integrations carrying them", () => {
    expect(runSendsLabel({ count: 3, integrations: ["Slack", "Resend"] })).toBe(
      "3 sends: Slack, Resend"
    );
  });

  it("keeps the count singular for one send", () => {
    expect(runSendsLabel({ count: 1, integrations: ["Slack"] })).toBe(
      "1 send: Slack"
    );
  });

  // A published graph whose steps only read: worth saying, since the band is
  // where the operator looks for what a live run will do.
  it("says so when the graph sends nothing", () => {
    expect(runSendsLabel({ count: 0, integrations: [] })).toBe("No sends");
  });
});

describe("runOverlayCopy", () => {
  it("says what the draft run does, and stops there", () => {
    expect(runOverlayCopy({ graph: "draft" })).toEqual({
      title: "Run draft",
      description: "Runs the draft on this canvas with test recipients.",
      confirmLabel: "Run draft",
    });
  });

  // The heading names the version in prose, and the button names the
  // consequence rather than repeating the version.
  it("makes a live published run's button name the consequence", () => {
    expect(
      runOverlayCopy({
        graph: "published",
        publishedVersion: 7,
        workflowMode: "live",
      })
    ).toEqual({
      title: "Run Published v7",
      description: "Runs Published v7 and sends to real recipients.",
      confirmLabel: "Send to real recipients",
    });
  });

  it("keeps the verb on a test published run's button", () => {
    expect(
      runOverlayCopy({
        graph: "published",
        publishedVersion: 7,
        workflowMode: "test",
      })
    ).toEqual({
      title: "Run Published v7",
      description: "Runs Published v7 with test recipients.",
      confirmLabel: "Run v7 · Test",
    });
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
