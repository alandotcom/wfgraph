import { describe, expect, it } from "vitest";
import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import type { AgentEvalDocument } from "#src/agent/result";
import {
  assessGraphGrounding,
  assessPublishability,
} from "#src/agent/judges/graph";

function validDocument(): AgentEvalDocument {
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
              allowManualStart: false,
              correlationPaths: { "applicant.created": "applicantId" },
            },
          },
        },
      },
      {
        id: "score",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Score applicant",
          type: "action",
          config: {
            actionType: "score-applicant",
            applicantId: "{{@entry:Lifecycle.applicantId}}",
          },
        },
      },
    ],
    edges: [
      {
        id: "start-score",
        source: "entry",
        target: "score",
        sourceHandle: "started",
      },
    ],
  };
}

describe("assessPublishability", () => {
  it("accepts a graph that passes the publish-time checks", () => {
    expect(
      assessPublishability({
        document: validDocument(),
        catalog: fixtureCatalog,
        integrations: [],
      })
    ).toEqual({ score: 1, rationale: "The graph is ready to publish." });
  });

  it("reports an unreachable subtree", () => {
    const document = validDocument();
    document.edges = [];

    expect(
      assessPublishability({
        document,
        catalog: fixtureCatalog,
        integrations: [],
      })
    ).toMatchObject({
      score: 0,
      rationale: expect.stringContaining("Unreachable"),
    });
  });
});

describe("assessGraphGrounding", () => {
  it("rejects action ids and integration ids absent from the scenario", () => {
    const document = validDocument();
    document.nodes[1] = {
      ...document.nodes[1],
      data: {
        ...document.nodes[1].data,
        config: {
          actionType: "invented/send-message",
          integrationId: "invented-connection",
        },
      },
    };

    expect(
      assessGraphGrounding({
        document,
        catalog: fixtureCatalog,
        integrations: [],
      })
    ).toEqual({
      score: 0,
      rationale:
        "Unknown action invented/send-message on Score applicant; unknown integration invented-connection on Score applicant.",
    });
  });

  it("treats a blank integration id as unconfigured", () => {
    const document = validDocument();
    document.nodes[1] = {
      ...document.nodes[1],
      data: {
        ...document.nodes[1].data,
        config: {
          actionType: "slack/send-message",
          integrationId: "",
          channel: "#recruiting",
          text: "Applicant created",
        },
      },
    };

    expect(
      assessGraphGrounding({
        document,
        catalog: fixtureCatalog,
        integrations: [],
      })
    ).toEqual({ score: 1, rationale: "Every graph identifier is grounded." });
  });
});
