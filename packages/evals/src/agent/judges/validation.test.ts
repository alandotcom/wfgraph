import { describe, expect, it } from "vitest";
import type { AgentTraceEvent } from "@wfgraph/core/backend/agent/trace";
import type { JsonObject } from "@wfgraph/shared/types/json";
import type { CompletionFacts } from "#src/agent/completion-facts";
import { buildAgentTrajectory } from "#src/agent/trajectory";
import { assessValidation } from "#src/agent/judges/validation";

const facts: CompletionFacts = {
  graphStatus: "blocked",
  responseStatus: "answered",
  turnStatus: "completed",
  structuralIssues: [],
  publishBlockers: [
    {
      kind: "missing_integration",
      message: "Slack needs a connection",
      nodeId: "notify",
    },
  ],
  warnings: [{ kind: "warning", message: "Review message" }],
  finalFinishReason: "stop",
};

function revision(id: string, number: number): AgentTraceEvent[] {
  return [
    { type: "tool-call", step: number, id, name: "add_node", input: {} },
    {
      type: "tool-result",
      step: number,
      id,
      name: "add_node",
      result: {},
      failed: false,
      graphRevision: number,
    },
    {
      type: "graph-revision",
      step: number,
      toolCallId: id,
      revision: number,
      document: { nodes: [], edges: [] },
    },
  ];
}

function validationResult(id: string, result: JsonObject): AgentTraceEvent[] {
  return [
    { type: "tool-call", step: 3, id, name: "validate_workflow", input: {} },
    {
      type: "tool-result",
      step: 3,
      id,
      name: "validate_workflow",
      result,
      failed: false,
    },
  ];
}

function matchingValidationResult(): JsonObject {
  return {
    draftValid: true,
    structuralIssues: [],
    publishBlockers: [
      {
        kind: "missing_integration",
        message: "Slack needs a connection",
        nodeId: "notify",
      },
    ],
    warnings: [{ kind: "warning", message: "Review message" }],
  };
}

describe("assessValidation", () => {
  it("does not require validation when no graph revision succeeded", () => {
    expect(
      assessValidation({ facts, trajectory: buildAgentTrajectory([]) })
    ).toMatchObject({
      score: 1,
    });
  });

  it("accepts a successful validation after the final graph revision", () => {
    expect(
      assessValidation({
        facts,
        trajectory: buildAgentTrajectory([
          ...revision("write", 1),
          ...validationResult("validate", matchingValidationResult()),
        ]),
      })
    ).toMatchObject({ score: 1 });
  });

  it("rejects validation that became stale after a later graph revision", () => {
    expect(
      assessValidation({
        facts,
        trajectory: buildAgentTrajectory([
          ...revision("first-write", 1),
          ...validationResult("validate", matchingValidationResult()),
          ...revision("second-write", 2),
        ]),
      })
    ).toMatchObject({ score: 0, rationale: expect.stringContaining("later") });
  });

  it("rejects a validation call made before the final graph revision", () => {
    expect(
      assessValidation({
        facts,
        trajectory: buildAgentTrajectory([
          {
            type: "tool-call",
            step: 1,
            id: "validate",
            name: "validate_workflow",
            input: {},
          },
          ...revision("write", 2),
          {
            type: "tool-result",
            step: 1,
            id: "validate",
            name: "validate_workflow",
            result: matchingValidationResult(),
            failed: false,
          },
        ]),
      })
    ).toMatchObject({ score: 0, rationale: expect.stringContaining("later") });
  });

  it("leaves an unmatched graph revision to Recovery", () => {
    const trajectory = buildAgentTrajectory([
      {
        type: "tool-call",
        step: 1,
        id: "reused-id",
        name: "add_node",
        input: {},
      },
      {
        type: "graph-revision",
        step: 1,
        toolCallId: "reused-id",
        revision: 1,
        document: { nodes: [], edges: [] },
      },
      {
        type: "tool-call",
        step: 2,
        id: "reused-id",
        name: "add_node",
        input: {},
      },
      {
        type: "tool-result",
        step: 1,
        id: "reused-id",
        name: "add_node",
        result: {},
        failed: false,
        graphRevision: 1,
      },
    ]);

    expect(trajectory.graphRevisions).toEqual([
      expect.objectContaining({ matchStatus: "unmatched" }),
    ]);
    expect(
      assessValidation({
        facts,
        trajectory,
      })
    ).toMatchObject({ score: 1 });
  });

  it("leaves an inconsistent write to Recovery", () => {
    expect(
      assessValidation({
        facts,
        trajectory: buildAgentTrajectory([
          {
            type: "tool-call",
            step: 1,
            id: "validate",
            name: "validate_workflow",
            input: {},
          },
          {
            type: "tool-call",
            step: 2,
            id: "write",
            name: "add_node",
            input: {},
          },
          {
            type: "tool-result",
            step: 2,
            id: "write",
            name: "add_node",
            result: {},
            failed: false,
            graphRevision: 1,
          },
          {
            type: "tool-result",
            step: 1,
            id: "validate",
            name: "validate_workflow",
            result: matchingValidationResult(),
            failed: false,
          },
        ]),
      })
    ).toMatchObject({ score: 1 });
  });

  it("rejects a validation result that does not match completion facts", () => {
    expect(
      assessValidation({
        facts,
        trajectory: buildAgentTrajectory([
          ...revision("write", 1),
          ...validationResult("validate", {
            ...matchingValidationResult(),
            warnings: [],
          }),
        ]),
      })
    ).toMatchObject({
      score: 0,
      rationale: expect.stringContaining("warnings"),
    });
  });

  it.each([
    [
      "draftValid",
      {
        ...matchingValidationResult(),
        draftValid: false,
      },
    ],
    [
      "structuralIssues",
      {
        ...matchingValidationResult(),
        structuralIssues: ["Unexpected structure"],
      },
    ],
    [
      "publishBlockers",
      {
        ...matchingValidationResult(),
        publishBlockers: [],
      },
    ],
  ] satisfies Array<[string, JsonObject]>)(
    "rejects a validation result with mismatched %s",
    (field, result) => {
      expect(
        assessValidation({
          facts,
          trajectory: buildAgentTrajectory([
            ...revision("write", 1),
            ...validationResult("validate", result),
          ]),
        })
      ).toMatchObject({ score: 0, rationale: expect.stringContaining(field) });
    }
  );

  it("uses the latest successful validation after the final graph revision", () => {
    expect(
      assessValidation({
        facts,
        trajectory: buildAgentTrajectory([
          ...revision("write", 1),
          ...validationResult("stale", {
            ...matchingValidationResult(),
            warnings: [],
          }),
          ...validationResult("fresh", matchingValidationResult()),
        ]),
      })
    ).toMatchObject({ score: 1 });
  });
});
