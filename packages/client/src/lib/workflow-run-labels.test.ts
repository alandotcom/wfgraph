import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  NOTHING_PUBLISHED_LABEL,
  publishedModeChoice,
  publishedModeWord,
  publishedRunLabel,
  runGraphLabel,
  runGraphRecipientsLabel,
  runOverlayCopy,
  testRunStepsSentence,
  runRecipientsLabel,
  runSendsLabel,
  runCommandLabel,
  workflowRunTarget,
  publicationChipLabel,
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
  // Events start runs in both modes; only what the steps reach differs.
  it("says what each mode does", () => {
    expect(publishedModeChoice("live")).toEqual({
      label: "Live",
      description:
        "Real Events start runs, and every step reaches real recipients.",
    });
    expect(publishedModeChoice("test")).toEqual({
      label: "Test",
      description:
        "Real Events still start runs, and each step follows its In test runs setting.",
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
  // A test run sends nothing unless a step's setting or the app's handler
  // says to, so the dialog says what this graph's steps do in place of naming
  // recipients that may receive nothing.
  const steps = "Send reminder is skipped in this draft run.";

  it("describes the draft run by what its steps do, and names no version", () => {
    expect(runOverlayCopy({ graph: "draft" }, steps)).toEqual({
      title: "Run draft",
      description:
        "Runs the draft as a test run. Send reminder is skipped in this draft run. A Wait waits its full time unless you press Continue now.",
      confirmLabel: "Run draft",
    });
  });

  // The description says what the mode does, so the heading and the button
  // read the same in both Published modes.
  it("names the real recipients a live published run reaches", () => {
    expect(
      runOverlayCopy(
        { graph: "published", publishedVersion: 7, workflowMode: "live" },
        steps
      )
    ).toEqual({
      title: "Run v7",
      description: "Runs v7 and sends to real recipients.",
      confirmLabel: "Run v7",
    });
  });

  it("describes a test published run by what its steps do", () => {
    expect(
      runOverlayCopy(
        { graph: "published", publishedVersion: 7, workflowMode: "test" },
        "Send reminder is skipped in this test run."
      )
    ).toEqual({
      title: "Run v7",
      description:
        "Runs v7 as a test run. Send reminder is skipped in this test run.",
      confirmLabel: "Run v7",
    });
  });
});

describe("testRunStepsSentence", () => {
  const sms = (
    id: string,
    label: string,
    config: Record<string, unknown> = {}
  ): WorkflowNode => ({
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label,
      type: "action",
      config: { actionType: "sms/send", ...config },
    },
  });
  const step = (
    id: string,
    label: string,
    actionType: string,
    enabled?: boolean
  ): WorkflowNode => ({
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label,
      type: "action",
      config: { actionType },
      ...(enabled === false ? { enabled } : {}),
    },
  });
  const catalog: ExtensionCatalog = {
    entities: [],
    events: [],
    integrations: [],
    actions: [
      {
        id: "sms/send",
        label: "Send SMS",
        description: "",
        category: "SMS",
        sideEffect: true,
        configFields: [
          {
            key: "testBehavior",
            label: "In test runs",
            type: "select",
            defaultValue: "log_only",
            options: [
              { value: "log_only", label: "Log only (do nothing)" },
              { value: "send_to_test_phone", label: "Send to test phone" },
            ],
          },
          {
            key: "testPhoneTo",
            label: "Test Phone Number",
            type: "text",
            showWhen: { field: "testBehavior", equals: "send_to_test_phone" },
          },
        ],
        outputFields: [],
      },
      {
        id: "patients/message",
        label: "Send Patient Message",
        description: "",
        category: "Patients",
        sideEffect: true,
        configFields: [],
        outputFields: [],
      },
      {
        id: "patients/lookup",
        label: "Find patient",
        description: "",
        category: "Patients",
        configFields: [],
        outputFields: [],
      },
    ],
  };
  const sentence = (nodes: WorkflowNode[]) =>
    testRunStepsSentence({ nodes, edges: [], catalog, run: "draft run" });

  it("names the steps a draft run skips, the ones that send to a test recipient, and the ones the app decides", () => {
    expect(
      sentence([
        sms("a", "Text the patient"),
        sms("b", "Text the front desk"),
        sms("c", "Text the test phone", {
          testBehavior: "send_to_test_phone",
          testPhoneTo: "+15557654321",
        }),
        step("d", "Send intake form", "patients/message"),
        step("e", "Look up the patient", "patients/lookup"),
        step("f", "Wait a day", BUILT_IN_ACTION_IDS.wait),
        step("g", "Old reminder", "patients/message", false),
      ])
    ).toBe(
      'Text the patient and Text the front desk are skipped in this draft run. Text the test phone sends to Test Phone Number "+15557654321". Send intake form runs as in a live run unless the app skips it.'
    );
  });

  it("says a test phone left empty means the step does nothing", () => {
    expect(
      sentence([
        sms("c", "Text the test phone", { testBehavior: "send_to_test_phone" }),
      ])
    ).toBe(
      "Text the test phone is set to Send to test phone, but Test Phone Number is empty, so it does nothing."
    );
  });

  it("counts past three names, and says when nothing reaches outside", () => {
    expect(
      sentence([
        sms("a", "A"),
        sms("b", "B"),
        sms("c", "C"),
        sms("d", "D"),
        sms("e", "E"),
      ])
    ).toBe("A, B, C and 2 more are skipped in this draft run.");
    expect(sentence([step("f", "Wait", BUILT_IN_ACTION_IDS.wait)])).toBe(
      "No step reaches outside this workflow."
    );
  });
});

describe("runGraphLabel", () => {
  it("labels a draft snapshot run as Draft", () => {
    expect(
      runGraphLabel({ versionKind: "draft_snapshot", versionNumber: null })
    ).toBe("Draft");
  });

  it("labels a published run by its version number", () => {
    expect(runGraphLabel({ versionKind: "published", versionNumber: 7 })).toBe(
      "v7"
    );
  });

  // The contract rejects a published version without a number, so this covers
  // a row that should never exist.
  it("falls back to Published when a published run carries no number", () => {
    expect(
      runGraphLabel({ versionKind: "published", versionNumber: null })
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

describe("publicationChipLabel", () => {
  const base = {
    isPaused: false,
    isPublished: true,
    workflowMode: "live" as const,
    publishedVersion: 2,
    hasUnpublishedChanges: false,
  };

  it("names the state in the Workflows list's words, then the version", () => {
    expect(publicationChipLabel(base)).toBe("Live · v2");
    expect(publicationChipLabel({ ...base, hasUnpublishedChanges: true })).toBe(
      "Live · v2 · changes not published"
    );
    expect(publicationChipLabel({ ...base, workflowMode: "test" })).toBe(
      "Test · v2"
    );
  });

  it("says Never published or Paused alone, since neither reaches anyone", () => {
    expect(
      publicationChipLabel({
        ...base,
        isPublished: false,
        publishedVersion: undefined,
        hasUnpublishedChanges: true,
      })
    ).toBe("Never published");
    expect(publicationChipLabel({ ...base, isPaused: true })).toBe(
      "Paused · Live · v2"
    );
  });
});
