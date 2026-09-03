import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { AgentEvalInput } from "#src/agent/types";
import { assessScenarioSemantics } from "#src/agent/judges/semantics";
import { completedDocument, input } from "#src/agent/judges/semantics/fixtures";

describe("assessScenarioSemantics", () => {
  it("accepts a required path with an intermediate action", () => {
    const document = completedDocument();
    document.nodes.push(
      {
        id: "profile",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Get applicant profile",
          type: "action",
          config: { actionType: "crm/get-applicant" },
        },
      },
      {
        id: "condition",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Score at least 80",
          type: "action",
          config: { actionType: "Condition" },
        },
      }
    );
    document.edges.push(
      { id: "score-profile", source: "score", target: "profile" },
      { id: "profile-condition", source: "profile", target: "condition" }
    );

    const pathInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredPaths: [
          {
            source: { kind: "action", actionId: "score-applicant" },
            target: { kind: "action", actionId: "Condition" },
          },
        ],
      },
    };

    expect(assessScenarioSemantics(pathInput, document)).toEqual({
      score: 1,
      rationale: "The graph satisfies the scenario constraints.",
    });
  });

  it("walks a graph whose node id names a prototype member", () => {
    const document = completedDocument();
    document.nodes.push({
      id: "constructor",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Notify",
        type: "action",
        config: { actionType: "crm/notify" },
      },
    });
    document.edges.push({
      id: "score-constructor",
      source: "score",
      target: "constructor",
    });

    const pathInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredPaths: [
          {
            source: { kind: "lifecycle" },
            target: { kind: "action", actionId: "crm/notify" },
          },
        ],
      },
    };

    // A node id arrives from the agent, so it is arbitrary text. Keyed in a
    // plain object, "constructor" answers with a prototype member and the walk
    // over it fails.
    expect(assessScenarioSemantics(pathInput, document)).toEqual({
      score: 1,
      rationale: "The graph satisfies the scenario constraints.",
    });
  });

  it("reports a missing required path", () => {
    const pathInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredPaths: [
          {
            source: { kind: "action", actionId: "score-applicant" },
            target: { kind: "action", actionId: "Condition" },
          },
        ],
      },
    };

    expect(assessScenarioSemantics(pathInput, completedDocument())).toEqual({
      score: 0,
      rationale: "missing required path score-applicant -> Condition.",
    });
  });

  it("rejects a required path that only continues through a disabled action", () => {
    const document = completedDocument();
    document.nodes.push(
      {
        id: "disabled-profile",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Get applicant profile",
          type: "action",
          enabled: false,
          config: { actionType: "crm/get-applicant" },
        },
      },
      {
        id: "condition",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Score at least 80",
          type: "action",
          config: { actionType: "Condition" },
        },
      }
    );
    document.edges.push(
      { id: "score-profile", source: "score", target: "disabled-profile" },
      {
        id: "profile-condition",
        source: "disabled-profile",
        target: "condition",
      }
    );
    const pathInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredPaths: [
          {
            source: { kind: "action", actionId: "score-applicant" },
            target: { kind: "action", actionId: "Condition" },
          },
        ],
      },
    };

    expect(assessScenarioSemantics(pathInput, document)).toEqual({
      score: 0,
      rationale: "missing required path score-applicant -> Condition.",
    });
  });

  it("rejects a target path that bypasses its required Condition outlet", () => {
    const document = completedDocument();
    document.nodes.push(
      {
        id: "condition",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Score at least 80",
          type: "action",
          config: { actionType: "Condition" },
        },
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
      }
    );
    document.edges.push(
      { id: "score-condition", source: "score", target: "condition" },
      {
        id: "condition-notify",
        source: "condition",
        target: "notify",
        sourceHandle: "true",
      },
      { id: "score-notify", source: "score", target: "notify" }
    );
    const gatedInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredGates: [
          {
            gate: { kind: "action", actionId: "Condition" },
            target: { kind: "action", actionId: "slack/send-message" },
            sourceHandle: "true",
          },
        ],
      },
    };

    expect(assessScenarioSemantics(gatedInput, document)).toEqual({
      score: 0,
      rationale:
        "a path to slack/send-message bypasses required gate Condition through true.",
    });
  });

  it("rejects a required flow whose target action is disabled", () => {
    const document = completedDocument();
    const score = document.nodes[1];
    if (!score) {
      throw new Error("Score fixture is missing");
    }
    score.data.enabled = false;
    const flowInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredFlows: [
          {
            source: { kind: "lifecycle" },
            target: { kind: "action", actionId: "score-applicant" },
            sourceHandle: "started",
          },
        ],
      },
    };

    expect(assessScenarioSemantics(flowInput, document)).toEqual({
      score: 0,
      rationale:
        "missing required flow lifecycle -> score-applicant through started.",
    });
  });

  it("rejects actions declared parallel when one is downstream of the other", () => {
    const document = completedDocument();
    document.nodes.push({
      id: "profile",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Get applicant",
        type: "action",
        config: { actionType: "crm/get-applicant" },
      },
    });
    document.edges.push({
      id: "score-profile",
      source: "score",
      target: "profile",
    });
    const parallelInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredParallel: [
          {
            first: { kind: "action", actionId: "score-applicant" },
            second: { kind: "action", actionId: "crm/get-applicant" },
          },
        ],
      },
    };

    expect(assessScenarioSemantics(parallelInput, document)).toEqual({
      score: 0,
      rationale:
        "score-applicant and crm/get-applicant are not parallel branches.",
    });
  });

  it("rejects exclusive branches whose outlets share one direct target", () => {
    const document = completedDocument();
    document.nodes.push(
      {
        id: "split",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Event Split",
          type: "action",
          config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
        },
      },
      {
        id: "notify",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Notify appointments",
          type: "action",
          config: { actionType: "slack/send-message" },
        },
      }
    );
    document.edges.push(
      {
        id: "created-notify",
        source: "split",
        target: "notify",
        sourceHandle: "event:app/appointment.created",
      },
      {
        id: "rescheduled-notify",
        source: "split",
        target: "notify",
        sourceHandle: "event:app/appointment.rescheduled",
      }
    );
    const branchesInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredExclusiveBranches: [
          {
            source: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.eventSplit,
              label: "Event Split",
            },
            branches: [
              {
                sourceHandle: "event:app/appointment.created",
                target: { kind: "action", actionId: "slack/send-message" },
              },
              {
                sourceHandle: "event:app/appointment.rescheduled",
                target: { kind: "action", actionId: "slack/send-message" },
              },
            ],
          },
        ],
      },
    };

    expect(assessScenarioSemantics(branchesInput, document)).toEqual({
      score: 0,
      rationale: "Event Split exclusive outlets must not share direct targets.",
    });
  });

  it("rejects exclusive branches when one branch target reaches another", () => {
    const document = completedDocument();
    document.nodes.push(
      {
        id: "split",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Event Split",
          type: "action",
          config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
        },
      },
      {
        id: "created-notify",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Created message",
          type: "action",
          config: { actionType: "slack/send-message" },
        },
      },
      {
        id: "rescheduled-notify",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Rescheduled message",
          type: "action",
          config: { actionType: "slack/send-message" },
        },
      }
    );
    document.edges.push(
      {
        id: "created-branch",
        source: "split",
        target: "created-notify",
        sourceHandle: "event:app/appointment.created",
      },
      {
        id: "rescheduled-branch",
        source: "split",
        target: "rescheduled-notify",
        sourceHandle: "event:app/appointment.rescheduled",
      },
      {
        id: "created-then-rescheduled",
        source: "created-notify",
        target: "rescheduled-notify",
      }
    );
    const branchesInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredExclusiveBranches: [
          {
            source: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.eventSplit,
              label: "Event Split",
            },
            branches: [
              {
                sourceHandle: "event:app/appointment.created",
                target: { kind: "action", actionId: "slack/send-message" },
              },
              {
                sourceHandle: "event:app/appointment.rescheduled",
                target: { kind: "action", actionId: "slack/send-message" },
              },
            ],
          },
        ],
      },
    };

    expect(assessScenarioSemantics(branchesInput, document)).toEqual({
      score: 0,
      rationale: "Event Split branch targets must not reach one another.",
    });
  });

  it("rejects exclusive branches when one outlet also targets another outlet's target", () => {
    const document = completedDocument();
    document.nodes.push(
      {
        id: "split",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Event Split",
          type: "action",
          config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
        },
      },
      {
        id: "created-notify",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Created message",
          type: "action",
          config: { actionType: "slack/send-message" },
        },
      },
      {
        id: "rescheduled-notify",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Rescheduled message",
          type: "action",
          config: { actionType: "slack/send-message" },
        },
      }
    );
    document.edges.push(
      {
        id: "created-created",
        source: "split",
        target: "created-notify",
        sourceHandle: "event:app/appointment.created",
      },
      {
        id: "created-rescheduled",
        source: "split",
        target: "rescheduled-notify",
        sourceHandle: "event:app/appointment.created",
      },
      {
        id: "rescheduled-rescheduled",
        source: "split",
        target: "rescheduled-notify",
        sourceHandle: "event:app/appointment.rescheduled",
      }
    );
    const branchesInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredExclusiveBranches: [
          {
            source: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.eventSplit,
              label: "Event Split",
            },
            branches: [
              {
                sourceHandle: "event:app/appointment.created",
                target: { kind: "action", actionId: "slack/send-message" },
              },
              {
                sourceHandle: "event:app/appointment.rescheduled",
                target: { kind: "action", actionId: "slack/send-message" },
              },
            ],
          },
        ],
      },
    };

    expect(assessScenarioSemantics(branchesInput, document)).toEqual({
      score: 0,
      rationale: "Event Split exclusive outlets must not share direct targets.",
    });
  });

  it("rejects an outlet that reaches another outlet's target through an intermediate node", () => {
    const document = completedDocument();
    document.nodes.push(
      {
        id: "split",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Event Split",
          type: "action",
          config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
        },
      },
      {
        id: "created-notify",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Created message",
          type: "action",
          config: { actionType: "slack/send-message" },
        },
      },
      {
        id: "route-to-rescheduled",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Route to rescheduled",
          type: "action",
          config: { actionType: "crm/get-applicant" },
        },
      },
      {
        id: "rescheduled-notify",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Rescheduled message",
          type: "action",
          config: { actionType: "slack/send-message" },
        },
      }
    );
    document.edges.push(
      {
        id: "created-branch",
        source: "split",
        target: "created-notify",
        sourceHandle: "event:app/appointment.created",
      },
      {
        id: "created-intermediate",
        source: "split",
        target: "route-to-rescheduled",
        sourceHandle: "event:app/appointment.created",
      },
      {
        id: "intermediate-rescheduled",
        source: "route-to-rescheduled",
        target: "rescheduled-notify",
      },
      {
        id: "rescheduled-branch",
        source: "split",
        target: "rescheduled-notify",
        sourceHandle: "event:app/appointment.rescheduled",
      }
    );
    const branchesInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredExclusiveBranches: [
          {
            source: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.eventSplit,
              label: "Event Split",
            },
            branches: [
              {
                sourceHandle: "event:app/appointment.created",
                target: { kind: "action", actionId: "slack/send-message" },
              },
              {
                sourceHandle: "event:app/appointment.rescheduled",
                target: { kind: "action", actionId: "slack/send-message" },
              },
            ],
          },
        ],
      },
    };

    expect(assessScenarioSemantics(branchesInput, document)).toEqual({
      score: 0,
      rationale:
        "Event Split exclusive outlets must not reach another outlet's target.",
    });
  });

  it("accepts a repeated target selector assigned to separate direct targets", () => {
    const document = completedDocument();
    document.nodes.push(
      {
        id: "split",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Event Split",
          type: "action",
          config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
        },
      },
      {
        id: "created-notify",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Created message",
          type: "action",
          config: { actionType: "slack/send-message" },
        },
      },
      {
        id: "rescheduled-notify",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Rescheduled message",
          type: "action",
          config: { actionType: "slack/send-message" },
        },
      }
    );
    document.edges.push(
      {
        id: "created-branch",
        source: "split",
        target: "created-notify",
        sourceHandle: "event:app/appointment.created",
      },
      {
        id: "rescheduled-branch",
        source: "split",
        target: "rescheduled-notify",
        sourceHandle: "event:app/appointment.rescheduled",
      }
    );
    const branchesInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredExclusiveBranches: [
          {
            source: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.eventSplit,
              label: "Event Split",
            },
            branches: [
              {
                sourceHandle: "event:app/appointment.created",
                target: { kind: "action", actionId: "slack/send-message" },
              },
              {
                sourceHandle: "event:app/appointment.rescheduled",
                target: { kind: "action", actionId: "slack/send-message" },
              },
            ],
          },
        ],
      },
    };

    expect(assessScenarioSemantics(branchesInput, document)).toMatchObject({
      score: 1,
    });
  });
});
