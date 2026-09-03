import { describe, expect, it } from "vitest";
import type { CompletionFacts } from "#src/agent/completion-facts";
import {
  assessExpectedCompletion,
  type CompletionAssessmentInput,
} from "#src/agent/judges/completion";

const readyFacts: CompletionFacts = {
  graphStatus: "ready",
  responseStatus: "answered",
  turnStatus: "completed",
  structuralIssues: [],
  publishBlockers: [],
  warnings: [],
  finalFinishReason: "stop",
};

const blockedFacts: CompletionFacts = {
  ...readyFacts,
  graphStatus: "blocked",
  publishBlockers: [
    {
      kind: "missing_integration",
      message: 'Node "Notify recruiting" needs a connected slack integration.',
      nodeId: "notify",
      nodeLabel: "Notify recruiting",
    },
  ],
};

function assess(input: CompletionAssessmentInput) {
  return assessExpectedCompletion(input);
}

describe("assessExpectedCompletion", () => {
  it("accepts a ready workflow with a matching answer", () => {
    expect(
      assess({
        expected: { outcome: "ready" },
        finalText: "The workflow is ready to publish.",
        facts: readyFacts,
      })
    ).toEqual({
      score: 1,
      rationale: "The workflow is ready to publish as expected.",
    });
  });

  it("accepts production warnings on a ready graph", () => {
    expect(
      assess({
        expected: { outcome: "ready" },
        finalText: "The workflow is ready to publish.",
        facts: {
          ...readyFacts,
          warnings: [
            { kind: "broken_reference", message: "Missing reference" },
          ],
        },
      })
    ).toMatchObject({ score: 1 });
  });

  it("rejects a ready graph when the answer claims publication is blocked", () => {
    expect(
      assess({
        expected: { outcome: "ready" },
        finalText: "The workflow cannot publish until Slack is connected.",
        facts: readyFacts,
      })
    ).toEqual({
      score: 0,
      rationale:
        "The answer claims a publish blocker while the workflow is ready.",
    });
  });

  it("rejects the passive publication blocker wording on a ready graph", () => {
    expect(
      assess({
        expected: { outcome: "ready" },
        finalText: "Publishing is blocked until Slack is connected.",
        facts: readyFacts,
      })
    ).toEqual({
      score: 0,
      rationale:
        "The answer claims a publish blocker while the workflow is ready.",
    });
  });

  it.each([
    "The workflow is not ready for publication.",
    "The workflow cannot be published.",
    "The workflow is not publishable.",
  ])("rejects ready graphs when the answer says %s", (finalText) => {
    expect(
      assess({
        expected: { outcome: "ready" },
        finalText,
        facts: readyFacts,
      })
    ).toEqual({
      score: 0,
      rationale:
        "The answer claims a publish blocker while the workflow is ready.",
    });
  });

  it("rejects a ready expectation when the graph is structurally invalid", () => {
    expect(
      assess({
        expected: { outcome: "ready" },
        finalText: "The workflow is ready to publish.",
        facts: {
          ...readyFacts,
          graphStatus: "invalid",
          structuralIssues: ["Graph must be acyclic"],
        },
      })
    ).toEqual({
      score: 0,
      rationale: "Graph must be acyclic",
    });
  });

  it("accepts a blocked draft whose answer names the production blocker", () => {
    expect(
      assess({
        expected: {
          outcome: "blocked",
          answerMustMention: ["slack"],
          answerMustMentionOneOf: ["connect", "integration"],
          requiredPublishBlocker: {
            kind: "missing_integration",
            messageMustMention: ["connected slack integration"],
          },
          allowedPublishBlockerKinds: ["missing_integration"],
        },
        finalText:
          "The draft is complete. Connect a Slack integration to publish it.",
        facts: blockedFacts,
      })
    ).toEqual({
      score: 1,
      rationale:
        "The valid draft contains the requested work and names its publish blocker.",
    });
  });

  it("rejects a blocked expectation when the graph is ready", () => {
    expect(
      assess({
        expected: {
          outcome: "blocked",
          answerMustMention: ["slack"],
          requiredPublishBlocker: {
            kind: "missing_integration",
            messageMustMention: ["connected slack integration"],
          },
          allowedPublishBlockerKinds: ["missing_integration"],
        },
        finalText: "Connect Slack before publishing.",
        facts: readyFacts,
      })
    ).toEqual({
      score: 0,
      rationale:
        "The workflow is ready to publish, but a blocked draft was expected.",
    });
  });

  it("rejects a blocked expectation when the graph is structurally invalid", () => {
    expect(
      assess({
        expected: {
          outcome: "blocked",
          answerMustMention: ["slack"],
          requiredPublishBlocker: {
            kind: "missing_integration",
            messageMustMention: ["connected slack integration"],
          },
          allowedPublishBlockerKinds: ["missing_integration"],
        },
        finalText: "Connect Slack before publishing.",
        facts: {
          ...blockedFacts,
          graphStatus: "invalid",
          structuralIssues: [
            "Graph contains edges with missing source/target nodes",
          ],
        },
      })
    ).toEqual({
      score: 0,
      rationale: "Graph contains edges with missing source/target nodes",
    });
  });

  it("matches all blocker terms against one required blocker message", () => {
    expect(
      assess({
        expected: {
          outcome: "blocked",
          answerMustMention: ["slack"],
          requiredPublishBlocker: {
            kind: "missing_integration",
            messageMustMention: ["connected slack integration"],
          },
          allowedPublishBlockerKinds: ["invalid_event", "missing_integration"],
        },
        finalText: "Connect Slack before publishing.",
        facts: {
          ...blockedFacts,
          publishBlockers: [
            { kind: "invalid_event", message: "Unknown event" },
            ...blockedFacts.publishBlockers,
          ],
        },
      })
    ).toMatchObject({ score: 1 });
  });

  it("rejects blocker terms split across separate blocker messages", () => {
    expect(
      assess({
        expected: {
          outcome: "blocked",
          answerMustMention: ["slack"],
          requiredPublishBlocker: {
            kind: "missing_integration",
            messageMustMention: ["connected", "slack integration"],
          },
          allowedPublishBlockerKinds: ["missing_integration"],
        },
        finalText: "Connect Slack before publishing.",
        facts: {
          ...blockedFacts,
          publishBlockers: [
            {
              kind: "missing_integration",
              message: "A connected integration is required.",
            },
            {
              kind: "missing_integration",
              message: "The Slack integration is required.",
            },
          ],
        },
      })
    ).toEqual({
      score: 0,
      rationale:
        "The publication failure does not match the expected human blocker.",
    });
  });

  it("rejects an unrelated publication blocker kind", () => {
    expect(
      assess({
        expected: {
          outcome: "blocked",
          answerMustMention: ["slack"],
          requiredPublishBlocker: {
            kind: "missing_integration",
            messageMustMention: ["connected slack integration"],
          },
          allowedPublishBlockerKinds: ["missing_integration"],
        },
        finalText: "Connect Slack before publishing.",
        facts: {
          ...blockedFacts,
          publishBlockers: [
            ...blockedFacts.publishBlockers,
            { kind: "invalid_event", message: "Unknown event" },
          ],
        },
      })
    ).toEqual({
      score: 0,
      rationale:
        "The publication failure contains an unexpected blocker: invalid_event.",
    });
  });

  it("allows multiple blockers of an allowed kind", () => {
    expect(
      assess({
        expected: {
          outcome: "blocked",
          answerMustMention: ["slack"],
          requiredPublishBlocker: {
            kind: "missing_integration",
            messageMustMention: ["connected slack integration"],
          },
          allowedPublishBlockerKinds: ["missing_integration"],
        },
        finalText: "Connect Slack before publishing.",
        facts: {
          ...blockedFacts,
          publishBlockers: [
            ...blockedFacts.publishBlockers,
            {
              kind: "missing_integration",
              message:
                'Node "Notify billing" needs a connected slack integration.',
            },
          ],
        },
      })
    ).toMatchObject({ score: 1 });
  });

  it("rejects a blocked answer that claims publish readiness", () => {
    expect(
      assess({
        expected: {
          outcome: "blocked",
          answerMustMention: ["slack"],
          requiredPublishBlocker: {
            kind: "missing_integration",
            messageMustMention: ["connected slack integration"],
          },
          allowedPublishBlockerKinds: ["missing_integration"],
        },
        finalText: "The Slack workflow is ready to publish.",
        facts: blockedFacts,
      })
    ).toEqual({
      score: 0,
      rationale:
        "The answer claims publish readiness while the workflow has a blocker.",
    });
  });

  it("rejects a blocked answer that says the workflow is ready for publication", () => {
    expect(
      assess({
        expected: {
          outcome: "blocked",
          answerMustMention: ["slack"],
          requiredPublishBlocker: {
            kind: "missing_integration",
            messageMustMention: ["connected slack integration"],
          },
          allowedPublishBlockerKinds: ["missing_integration"],
        },
        finalText: "The Slack workflow is ready for publication.",
        facts: blockedFacts,
      })
    ).toEqual({
      score: 0,
      rationale:
        "The answer claims publish readiness while the workflow has a blocker.",
    });
  });

  it("rejects a blocked answer that says publication is available now", () => {
    expect(
      assess({
        expected: {
          outcome: "blocked",
          answerMustMention: [],
          requiredPublishBlocker: {
            kind: "missing_integration",
            messageMustMention: ["connected slack integration"],
          },
          allowedPublishBlockerKinds: ["missing_integration"],
        },
        finalText: "You can publish now.",
        facts: blockedFacts,
      })
    ).toEqual({
      score: 0,
      rationale:
        "The answer claims publish readiness while the workflow has a blocker.",
    });
  });

  it.each([
    "The Slack connection is configured. The workflow can now be published.",
    "The Slack connection is configured. The workflow is now publishable.",
  ])(
    "rejects a blocked answer that claims publication is available through %s",
    (finalText) => {
      expect(
        assess({
          expected: {
            outcome: "blocked",
            answerMustMention: ["slack"],
            requiredPublishBlocker: {
              kind: "missing_integration",
              messageMustMention: ["connected slack integration"],
            },
            allowedPublishBlockerKinds: ["missing_integration"],
          },
          finalText,
          facts: blockedFacts,
        })
      ).toEqual({
        score: 0,
        rationale:
          "The answer claims publish readiness while the workflow has a blocker.",
      });
    }
  );

  it("accepts a blocked answer that states its prerequisite before publication", () => {
    expect(
      assess({
        expected: {
          outcome: "blocked",
          answerMustMention: ["slack", "connection"],
          requiredPublishBlocker: {
            kind: "missing_integration",
            messageMustMention: ["connected slack integration"],
          },
          allowedPublishBlockerKinds: ["missing_integration"],
        },
        finalText:
          "The draft requires a Slack connection before it can be published.",
        facts: blockedFacts,
      })
    ).toEqual({
      score: 1,
      rationale:
        "The valid draft contains the requested work and names its publish blocker.",
    });
  });

  it("accepts future readiness after the user resolves a named blocker", () => {
    expect(
      assess({
        expected: {
          outcome: "blocked",
          answerMustMention: ["slack", "connection"],
          requiredPublishBlocker: {
            kind: "missing_integration",
            messageMustMention: ["connected slack integration"],
          },
          allowedPublishBlockerKinds: ["missing_integration"],
        },
        finalText:
          "Choose the Slack connection, then it will be ready to publish.",
        facts: blockedFacts,
      })
    ).toEqual({
      score: 1,
      rationale:
        "The valid draft contains the requested work and names its publish blocker.",
    });
  });

  it.each([
    "Slack requires a connection before it can be published.",
    "Slack needs a connection before the workflow can be published.",
  ])(
    "rejects a ready answer that claims a publication blocker through %s",
    (finalText) => {
      expect(
        assess({
          expected: { outcome: "ready" },
          finalText,
          facts: readyFacts,
        })
      ).toEqual({
        score: 0,
        rationale:
          "The answer claims a publish blocker while the workflow is ready.",
      });
    }
  );

  it("accepts an unsupported request with a clear explanation", () => {
    expect(
      assess({
        expected: {
          outcome: "unsupported",
          answerMustMention: ["sms"],
          answerMustMentionOneOf: ["cannot", "unavailable"],
        },
        finalText: "SMS is unavailable in the current action catalog.",
        facts: readyFacts,
      })
    ).toEqual({
      score: 1,
      rationale: "The answer explains the unsupported capability.",
    });
  });

  it("accepts an unsupported answer that says no requested action is available", () => {
    expect(
      assess({
        expected: {
          outcome: "unsupported",
          answerMustMentionOneOf: ["SMS", "text message", "texting"],
        },
        finalText: "No texting/SMS action is available, so I can’t build this.",
        facts: readyFacts,
      })
    ).toEqual({
      score: 1,
      rationale: "The answer explains the unsupported capability.",
    });
  });

  it.each([
    "SMS can't be sent with an available action.",
    "SMS can’t be sent with an available action.",
    "I couldn't add SMS because this workspace has no SMS action.",
    "I couldn’t add SMS because this workspace has no SMS action.",
  ])("accepts unsupported explanations that say %s", (finalText) => {
    expect(
      assess({
        expected: { outcome: "unsupported", answerMustMention: ["SMS"] },
        finalText,
        facts: readyFacts,
      })
    ).toEqual({
      score: 1,
      rationale: "The answer explains the unsupported capability.",
    });
  });

  it("rejects an unsupported answer that lacks an explanation", () => {
    expect(
      assess({
        expected: { outcome: "unsupported" },
        finalText: "SMS.",
        facts: readyFacts,
      })
    ).toEqual({
      score: 0,
      rationale:
        "The answer does not clearly explain the unsupported capability.",
    });
  });

  it("accepts one focused clarification question", () => {
    expect(
      assess({
        expected: {
          outcome: "clarification",
          questionMustMention: ["slack", "channel"],
        },
        finalText: "Which Slack channel should receive the notification?",
        facts: readyFacts,
      })
    ).toEqual({
      score: 1,
      rationale: "The answer asks one focused clarification question.",
    });
  });

  it("accepts explanatory text after one clarification question", () => {
    expect(
      assess({
        expected: {
          outcome: "clarification",
          questionMustMention: ["event"],
        },
        finalText:
          "Which Event should start the workflow?\n\nAvailable Events:\n- applicant.created\n- applicant.withdrawn",
        facts: readyFacts,
      })
    ).toEqual({
      score: 1,
      rationale: "The answer asks one focused clarification question.",
    });
  });

  it("rejects a clarification answer with more than one question mark", () => {
    expect(
      assess({
        expected: {
          outcome: "clarification",
          questionMustMention: ["slack", "channel"],
        },
        finalText:
          "Which Slack channel should receive the notification? Which event starts it?",
        facts: readyFacts,
      })
    ).toEqual({
      score: 0,
      rationale: "The answer must contain one focused question.",
    });
  });

  it("rejects a clarification answer with no question mark", () => {
    expect(
      assess({
        expected: {
          outcome: "clarification",
          questionMustMention: ["event"],
        },
        finalText: "Please choose an Event to start the workflow.",
        facts: readyFacts,
      })
    ).toEqual({
      score: 0,
      rationale: "The answer must contain one focused question.",
    });
  });

  it("rejects a clarification question that omits required terms", () => {
    expect(
      assess({
        expected: {
          outcome: "clarification",
          questionMustMention: ["event", "action"],
        },
        finalText: "What?",
        facts: readyFacts,
      })
    ).toEqual({
      score: 0,
      rationale: "The clarification question does not mention: event, action.",
    });
  });

  it("checks clarification requirements against the question rather than earlier text", () => {
    expect(
      assess({
        expected: {
          outcome: "clarification",
          questionMustMention: ["event"],
        },
        finalText: "The Event is unknown. Can you clarify?",
        facts: readyFacts,
      })
    ).toEqual({
      score: 0,
      rationale: "The clarification question does not mention: event.",
    });
  });

  it("leaves an incomplete turn to Recovery when the completion meaning matches", () => {
    expect(
      assess({
        expected: { outcome: "ready" },
        finalText: "The workflow is ready to publish.",
        facts: {
          ...readyFacts,
          turnStatus: "incomplete",
          finalFinishReason: "length",
        },
      })
    ).toEqual({
      score: 1,
      rationale: "The workflow is ready to publish as expected.",
    });
  });

  it("allows a ready assessment with a missing response because Recovery owns response health", () => {
    expect(
      assess({
        expected: { outcome: "ready" },
        finalText: "",
        facts: { ...readyFacts, responseStatus: "missing" },
      })
    ).toEqual({
      score: 1,
      rationale: "The workflow is ready to publish as expected.",
    });
  });
});
