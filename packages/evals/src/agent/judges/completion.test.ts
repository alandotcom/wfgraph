import { describe, expect, it } from "vitest";
import type { AgentEvalDocument } from "#src/agent/result";
import { assessExpectedCompletion } from "#src/agent/judges/completion";

const passing = { score: 1, rationale: "passed" } as const;
const failing = {
  score: 0,
  rationale: "Node needs a connected slack integration.",
} as const;

function validDraft(): AgentEvalDocument {
  return {
    nodes: [
      {
        id: "entry",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: { label: "Lifecycle", type: "lifecycle" },
      },
      {
        id: "notify",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Notify recruiting",
          type: "action",
          config: { actionType: "slack/send-message" },
        },
      },
    ],
    edges: [
      {
        id: "entry-notify",
        source: "entry",
        target: "notify",
        sourceHandle: "started",
      },
    ],
  };
}

describe("assessExpectedCompletion", () => {
  it("accepts a ready workflow that passes publication checks", () => {
    expect(
      assessExpectedCompletion({
        expected: { outcome: "ready" },
        document: validDraft(),
        finalText: "The workflow is ready to publish.",
        errors: [],
        publishability: passing,
        grounding: passing,
        semantics: passing,
      })
    ).toEqual({
      score: 1,
      rationale: "The workflow is ready to publish as expected.",
    });
  });

  it("accepts a useful draft whose answer names its publish blocker", () => {
    expect(
      assessExpectedCompletion({
        expected: {
          outcome: "blocked",
          answerMustMention: ["slack"],
          answerMustMentionOneOf: ["connect", "integration"],
          publishBlockerMustMention: ["connected slack integration"],
        },
        document: validDraft(),
        finalText:
          "The draft is complete. Connect a Slack integration to publish it.",
        errors: [],
        publishability: failing,
        grounding: passing,
        semantics: passing,
      })
    ).toEqual({
      score: 1,
      rationale:
        "The valid draft contains the requested work and names its publish blocker.",
    });
  });

  it("rejects a blocked result caused by broken topology", () => {
    const document = validDraft();
    document.edges[0] = {
      ...document.edges[0],
      target: "missing-node",
    };

    expect(
      assessExpectedCompletion({
        expected: {
          outcome: "blocked",
          answerMustMention: ["slack"],
          publishBlockerMustMention: ["connected slack integration"],
        },
        document,
        finalText: "Connect Slack before publishing.",
        errors: [],
        publishability: failing,
        grounding: passing,
        semantics: passing,
      })
    ).toMatchObject({
      score: 0,
      rationale: expect.stringContaining("missing source/target nodes"),
    });
  });

  it("rejects a blocked result that omits the human action", () => {
    expect(
      assessExpectedCompletion({
        expected: {
          outcome: "blocked",
          answerMustMention: ["slack", "channel"],
          publishBlockerMustMention: ["connected slack integration"],
        },
        document: validDraft(),
        finalText: "Connect Slack before publishing.",
        errors: [],
        publishability: failing,
        grounding: passing,
        semantics: passing,
      })
    ).toEqual({
      score: 0,
      rationale: "The answer does not mention: channel.",
    });
  });

  it("rejects a blocked answer that claims publish readiness", () => {
    expect(
      assessExpectedCompletion({
        expected: {
          outcome: "blocked",
          answerMustMention: ["channel"],
          publishBlockerMustMention: ["connected slack integration"],
        },
        document: validDraft(),
        finalText:
          "The Slack channel is missing, but the workflow is ready to publish.",
        errors: [],
        publishability: failing,
        grounding: passing,
        semantics: passing,
      })
    ).toEqual({
      score: 0,
      rationale:
        "The answer claims publish readiness while the workflow has a blocker.",
    });
  });

  it("rejects a blocked result caused by a different publication failure", () => {
    expect(
      assessExpectedCompletion({
        expected: {
          outcome: "blocked",
          answerMustMention: ["channel"],
          publishBlockerMustMention: ["required field channel"],
        },
        document: validDraft(),
        finalText: "The channel remains for a person to configure.",
        errors: [],
        publishability: failing,
        grounding: passing,
        semantics: passing,
      })
    ).toEqual({
      score: 0,
      rationale:
        "The publication failure does not match the expected human blocker.",
    });
  });

  it("accepts an unsupported request when the graph stays grounded", () => {
    expect(
      assessExpectedCompletion({
        expected: {
          outcome: "unsupported",
          answerMustMention: ["sms"],
          answerMustMentionOneOf: ["cannot", "unavailable"],
        },
        document: { nodes: [], edges: [] },
        finalText: "SMS is unavailable in the current action catalog.",
        errors: [],
        publishability: failing,
        grounding: passing,
        semantics: passing,
      })
    ).toEqual({
      score: 1,
      rationale:
        "The answer explains the unsupported capability and the graph stays grounded.",
    });
  });

  it("rejects a stream failure for every expected outcome", () => {
    expect(
      assessExpectedCompletion({
        expected: { outcome: "ready" },
        document: validDraft(),
        finalText: "",
        errors: ["provider failed"],
        publishability: passing,
        grounding: passing,
        semantics: passing,
      })
    ).toEqual({
      score: 0,
      rationale: "The turn ended with 1 stream error.",
    });
  });
});
