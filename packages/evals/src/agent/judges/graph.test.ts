import { describe, expect, it } from "vitest";
import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import { validateAgentDraft } from "@wfgraph/core/backend/agent/publication-validation";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { collectCompletionFacts } from "#src/agent/completion-facts";
import type { AgentEvalDocument } from "#src/agent/result";
import { assessGraphGrounding } from "#src/agent/judges/graph";

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

const integrationEventCatalog: ExtensionCatalog = {
  ...fixtureCatalog,
  events: [
    ...fixtureCatalog.events,
    {
      name: "slack/message.posted",
      label: "Slack message posted",
      integration: "slack",
      payloadFields: [{ path: "channel", type: "string" }],
    },
  ],
};

describe("collectCompletionFacts", () => {
  it("derives response and turn status from the final response, errors, and finish", () => {
    const validation = validateAgentDraft({
      document: validDocument(),
      catalog: fixtureCatalog,
      integrations: [],
    });

    expect(
      collectCompletionFacts({
        validation,
        finalText: "",
        streamErrors: ["provider failed"],
        finalFinishReason: undefined,
      })
    ).toMatchObject({
      graphStatus: "ready",
      responseStatus: "missing",
      turnStatus: "failed",
      finalFinishReason: null,
    });
    expect(
      collectCompletionFacts({
        validation,
        finalText: "The workflow is ready.",
        streamErrors: ["late stream error"],
        finalFinishReason: "stop",
      })
    ).toMatchObject({
      responseStatus: "answered",
      turnStatus: "failed",
      finalFinishReason: "stop",
    });
    expect(
      collectCompletionFacts({
        validation,
        finalText: "The response stopped early.",
        streamErrors: [],
        finalFinishReason: "length",
      })
    ).toMatchObject({
      turnStatus: "incomplete",
      finalFinishReason: "length",
    });
  });

  it("marks a structurally invalid graph invalid when publication has no blockers", () => {
    const document = validDocument();
    document.edges.push({ ...document.edges[0], id: document.edges[0].id });
    const validation = validateAgentDraft({
      document,
      catalog: fixtureCatalog,
      integrations: [],
    });
    expect(validation.publishBlockers).toEqual([]);
    expect(validation.structuralIssues).toEqual([
      "Graph contains duplicate edge IDs",
    ]);

    expect(
      collectCompletionFacts({
        validation,
        finalText: "The graph is invalid.",
        streamErrors: [],
        finalFinishReason: "stop",
      })
    ).toMatchObject({
      graphStatus: "invalid",
      structuralIssues: ["Graph contains duplicate edge IDs"],
    });
  });

  it("keeps the production Start Filter blocker", () => {
    const document = validDocument();
    document.nodes[0] = {
      ...document.nodes[0],
      data: {
        ...document.nodes[0].data,
        config: {
          lifecycleRules: {
            startEvents: ["applicant.created"],
            cancelEvents: [],
            concurrency: "unlimited",
            allowManualStart: false,
            correlationPaths: { "applicant.created": "applicantId" },
            startFilters: {
              "applicant.created": JSON.stringify({
                version: 2,
                groupLogic: "and",
                groups: [
                  {
                    id: "group",
                    logic: "and",
                    conditions: [
                      {
                        id: "rule",
                        field: "email",
                        fieldType: "string",
                        operator: "equals",
                        value: "",
                      },
                    ],
                  },
                ],
              }),
            },
          },
        },
      },
    };
    const validation = validateAgentDraft({
      document,
      catalog: fixtureCatalog,
      integrations: [],
    });

    const facts = collectCompletionFacts({
      validation,
      finalText: "The workflow needs a completed Start Filter.",
      streamErrors: [],
      finalFinishReason: "stop",
    });

    expect(facts.publishBlockers).toEqual(validation.publishBlockers);
    expect(facts.publishBlockers).toContainEqual(
      expect.objectContaining({ kind: "invalid_start_filter" })
    );
  });

  it("preserves production blockers and warnings together", () => {
    const document = validDocument();
    document.nodes[1] = {
      ...document.nodes[1],
      data: {
        ...document.nodes[1].data,
        config: {
          actionType: "slack/send-message",
          integrationId: "slack-primary",
          channel: "#recruiting",
          text: "Applicant {{@removed:Removed.email}}",
        },
      },
    };
    const validation = validateAgentDraft({
      document,
      catalog: fixtureCatalog,
      integrations: [{ id: "slack-primary", type: "slack" }],
    });

    const facts = collectCompletionFacts({
      validation,
      finalText: "The workflow is ready to publish.",
      streamErrors: [],
      finalFinishReason: "stop",
    });

    expect(facts.publishBlockers).toEqual(validation.publishBlockers);
    expect(facts.warnings).toEqual(validation.warnings);
    expect(facts.warnings).toContainEqual(
      expect.objectContaining({ kind: "broken_reference" })
    );
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

  it("rejects a stale Lifecycle Event connection id", () => {
    const document = validDocument();
    document.nodes[0] = {
      ...document.nodes[0],
      data: {
        ...document.nodes[0].data,
        label: "Slack lifecycle",
        config: {
          lifecycleRules: {
            startEvents: ["slack/message.posted"],
            cancelEvents: [],
            concurrency: "unlimited",
            allowManualStart: false,
            connectionIds: {
              "slack/message.posted": "deleted-slack",
            },
          },
        },
      },
    };

    expect(
      assessGraphGrounding({
        document,
        catalog: integrationEventCatalog,
        integrations: [],
      })
    ).toMatchObject({
      score: 0,
      rationale: expect.stringContaining(
        "unknown integration deleted-slack on Slack lifecycle"
      ),
    });
  });

  it("rejects a stale Wait Event connection id", () => {
    const document = validDocument();
    document.nodes.push({
      id: "wait-for-slack",
      type: "action",
      position: { x: 200, y: 0 },
      data: {
        label: "Wait for Slack",
        type: "action",
        config: {
          actionType: "Wait",
          waitMode: "event",
          waitFor: [
            {
              event: "slack/message.posted",
              connectionId: "deleted-slack",
            },
          ],
          waitTimeout: "7d",
        },
      },
    });

    expect(
      assessGraphGrounding({
        document,
        catalog: integrationEventCatalog,
        integrations: [],
      })
    ).toMatchObject({
      score: 0,
      rationale: expect.stringContaining(
        "unknown integration deleted-slack on Wait for Slack"
      ),
    });
  });
});
