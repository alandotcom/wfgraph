import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import type { AgentEvalDocument } from "#src/agent/result";
import { assessResolvableReferences } from "#src/agent/judges/resolvable-references";

const catalog = fixtureCatalog;

/**
 * A start, an optional wait, and a Slack step reading the token under test.
 * The wait is what decides whether that token is still readable.
 */
function documentWith(input: {
  readonly waitMode: "delay" | "event";
  readonly text: string;
}): AgentEvalDocument {
  return {
    nodes: [
      {
        id: "entry",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          label: "Lifecycle",
          type: "lifecycle",
          config: {
            lifecycleRules: {
              startEvents: ["applicant.created"],
              cancelEvents: [],
              concurrency: "unlimited",
            },
          },
        },
      },
      {
        id: "wait",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Hold",
          type: "action",
          config:
            input.waitMode === "event"
              ? {
                  actionType: BUILT_IN_ACTION_IDS.wait,
                  waitMode: "event",
                  waitFor: [{ event: "applicant.withdrawn" }],
                  waitTimeout: "7d",
                  waitTimeoutBehavior: "continue",
                }
              : {
                  actionType: BUILT_IN_ACTION_IDS.wait,
                  waitMode: "delay",
                  waitDuration: "1d",
                },
        },
      },
      {
        id: "notify",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Notify the team",
          type: "action",
          config: { actionType: "slack/send-message", text: input.text },
        },
      },
    ],
    edges: [
      { id: "e1", source: "entry", target: "wait", sourceHandle: "started" },
      { id: "e2", source: "wait", target: "notify" },
    ],
  };
}

describe("assessResolvableReferences", () => {
  it("passes a graph whose tokens all name readable paths", () => {
    const assessment = assessResolvableReferences({
      document: documentWith({
        waitMode: "delay",
        text: "Reach {{@entry:Lifecycle.email}}",
      }),
      catalog,
    });

    expect(assessment.score).toBe(1);
  });

  it("fails a token the Event wait above it made unreadable", () => {
    const assessment = assessResolvableReferences({
      document: documentWith({
        waitMode: "event",
        text: "Reach {{@entry:Lifecycle.email}}",
      }),
      catalog,
    });

    expect(assessment.score).toBe(0);
    expect(assessment.rationale).toContain("Notify the team.text");
  });

  it("passes a path the Event wait still offers below itself", () => {
    const assessment = assessResolvableReferences({
      document: documentWith({
        waitMode: "event",
        text: "Applicant {{@entry:Lifecycle.applicantId}}",
      }),
      catalog,
    });

    expect(assessment.score).toBe(1);
  });

  it("passes an empty graph", () => {
    expect(
      assessResolvableReferences({
        document: { nodes: [], edges: [] },
        catalog,
      }).score
    ).toBe(1);
  });
});
