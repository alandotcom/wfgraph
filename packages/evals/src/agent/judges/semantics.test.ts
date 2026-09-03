import { describe, expect, it } from "vitest";
import type { AgentEvalDocument } from "#src/agent/result";
import type { AgentEvalInput } from "#src/agent/types";
import { assessScenarioSemantics } from "#src/agent/judges/semantics";

const initialDocument: AgentEvalDocument = {
  nodes: [],
  edges: [],
};

const input: AgentEvalInput = {
  messages: [{ role: "user", content: "Score each new applicant." }],
  document: initialDocument,
  catalog: { events: [], actions: [], integrations: [] },
  integrations: [],
  expected: {
    requiredActions: { "score-applicant": 1 },
    startEvents: ["applicant.created"],
    requiredFlows: [
      {
        source: { kind: "lifecycle" },
        target: { kind: "action", actionId: "score-applicant" },
        sourceHandle: "started",
      },
    ],
  },
  expectedCompletion: { outcome: "ready" },
  intentCriteria: ["Each applicant is scored after the start Event."],
};

function completedDocument(): AgentEvalDocument {
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
        id: "score",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Score applicant",
          type: "action",
          config: { actionType: "score-applicant" },
        },
      },
    ],
    edges: [
      {
        id: "edge",
        source: "entry",
        target: "score",
        sourceHandle: "started",
      },
    ],
  };
}

describe("assessScenarioSemantics", () => {
  it("accepts a graph that satisfies the scenario constraints", () => {
    expect(assessScenarioSemantics(input, completedDocument())).toEqual({
      score: 1,
      rationale: "The graph satisfies the scenario constraints.",
    });
  });

  it("reports missing actions, Events, and flows together", () => {
    expect(assessScenarioSemantics(input, { nodes: [], edges: [] })).toEqual({
      score: 0,
      rationale:
        "Expected 1 score-applicant node, found 0; missing Start Event applicant.created; missing required flow lifecycle -> score-applicant through started.",
    });
  });

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

  it("rejects extra actions when a scenario declares an exact count", () => {
    const document = completedDocument();
    document.nodes.push({
      ...document.nodes[1],
      id: "extra-score",
    });
    const exactInput: AgentEvalInput = {
      ...input,
      expected: { exactActions: { "score-applicant": 1 } },
    };

    expect(assessScenarioSemantics(exactInput, document)).toEqual({
      score: 0,
      rationale: "Expected exactly 1 score-applicant node, found 2.",
    });
  });

  it("rejects a node whose required config differs", () => {
    const document = completedDocument();
    document.nodes.push({
      id: "wait",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Wait two days",
        type: "action",
        config: {
          actionType: "Wait",
          waitMode: "delay",
          waitDuration: "1d",
        },
      },
    });
    const configInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredConfigs: [
          {
            node: { kind: "action", actionId: "Wait" },
            values: { waitMode: "delay", waitDuration: "2d" },
          },
        ],
      },
    };

    expect(assessScenarioSemantics(configInput, document)).toEqual({
      score: 0,
      rationale: "Wait does not have required config waitMode, waitDuration.",
    });
  });

  it("rejects a node that keeps a forbidden config key", () => {
    const document = completedDocument();
    document.nodes.push({
      id: "wait",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Wait until the appointment",
        type: "action",
        config: {
          actionType: "Wait",
          waitMode: "delay",
          waitDelayTimingMode: "until",
          waitUntil: "{{entry.Lifecycle.appointment.startsAt}}",
          waitDuration: "1d",
        },
      },
    });
    const configInput: AgentEvalInput = {
      ...input,
      expected: {
        forbiddenConfigKeys: [
          {
            node: { kind: "action", actionId: "Wait" },
            keys: ["waitDuration"],
          },
        ],
      },
    };

    expect(assessScenarioSemantics(configInput, document)).toEqual({
      score: 0,
      rationale: "Wait has forbidden config waitDuration.",
    });
  });

  it("rejects a required config field that remains empty", () => {
    const document = completedDocument();
    document.nodes.push({
      id: "notify",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Notify recruiting",
        type: "action",
        config: { actionType: "slack/send-message", text: "" },
      },
    });
    const configInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredNonEmptyConfigs: [
          {
            node: { kind: "action", actionId: "slack/send-message" },
            keys: ["text"],
          },
        ],
      },
    };

    expect(assessScenarioSemantics(configInput, document)).toEqual({
      score: 0,
      rationale: "slack/send-message has empty required config text.",
    });
  });

  it("accepts equivalent duration spellings", () => {
    const document = completedDocument();
    document.nodes.push({
      id: "wait",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Wait two days",
        type: "action",
        config: { actionType: "Wait", waitDuration: "48h" },
      },
    });
    const durationInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredDurations: [
          {
            node: { kind: "action", actionId: "Wait" },
            key: "waitDuration",
            duration: "2d",
          },
        ],
      },
    };

    expect(assessScenarioSemantics(durationInput, document)).toEqual({
      score: 1,
      rationale: "The graph satisfies the scenario constraints.",
    });
  });

  it("rejects a Wait subscribed to the wrong Event", () => {
    const document = completedDocument();
    document.nodes.push({
      id: "wait",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Wait for payment",
        type: "action",
        config: {
          actionType: "Wait",
          waitMode: "event",
          waitFor: [{ event: "applicant.withdrawn" }],
        },
      },
    });
    const waitInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredWaitEvents: [
          {
            node: { kind: "action", actionId: "Wait" },
            events: ["billing/payment.settled"],
          },
        ],
      },
    };

    expect(assessScenarioSemantics(waitInput, document)).toEqual({
      score: 0,
      rationale: "Wait is missing required Wait Event billing/payment.settled.",
    });
  });

  it("rejects a Condition rule with the wrong threshold", () => {
    const document = completedDocument();
    document.nodes.push({
      id: "condition",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Score at least 80",
        type: "action",
        config: {
          actionType: "Condition",
          conditionModel: JSON.stringify({
            version: 2,
            groupLogic: "and",
            groups: [
              {
                id: "group",
                logic: "and",
                conditions: [
                  {
                    id: "rule",
                    field: "score",
                    fieldType: "number",
                    operator: "greater_or_equal",
                    value: 70,
                  },
                ],
              },
            ],
          }),
        },
      },
    });
    const conditionInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredConditionRules: [
          {
            node: { kind: "action", actionId: "Condition" },
            field: "score",
            operator: "greater_or_equal",
            value: 80,
          },
        ],
      },
    };

    expect(assessScenarioSemantics(conditionInput, document)).toEqual({
      score: 0,
      rationale:
        "Condition is missing required rule score greater_or_equal 80.",
    });
  });

  it("rejects a Start Filter rule with the wrong value", () => {
    const document = completedDocument();
    const lifecycle = document.nodes[0];
    if (!lifecycle) {
      throw new Error("Lifecycle fixture is missing");
    }
    lifecycle.data.config = {
      lifecycleRules: {
        startEvents: ["applicant.created"],
        cancelEvents: [],
        concurrency: "unlimited",
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
                    field: "status",
                    fieldType: "string",
                    operator: "equals",
                    value: "pending",
                  },
                ],
              },
            ],
          }),
        },
      },
    };
    const filterInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredStartFilters: [
          {
            event: "applicant.created",
            filter: {
              groupLogic: "and",
              groups: [
                {
                  logic: "and",
                  rules: [
                    {
                      field: "status",
                      fieldType: "string",
                      operator: "equals",
                      value: "confirmed",
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };

    expect(assessScenarioSemantics(filterInput, document)).toEqual({
      score: 0,
      rationale:
        "applicant.created does not have the exact required Start Filter.",
    });
  });

  it("rejects a Start Filter whose extra branch bypasses the required rule", () => {
    const document = completedDocument();
    const lifecycle = document.nodes[0];
    if (!lifecycle) {
      throw new Error("Lifecycle fixture is missing");
    }
    lifecycle.data.config = {
      lifecycleRules: {
        startEvents: ["applicant.created"],
        cancelEvents: [],
        concurrency: "unlimited",
        startFilters: {
          "applicant.created": JSON.stringify({
            version: 2,
            groupLogic: "or",
            groups: [
              {
                id: "required-group",
                logic: "and",
                conditions: [
                  {
                    id: "required-rule",
                    field: "status",
                    fieldType: "string",
                    operator: "equals",
                    value: "confirmed",
                  },
                ],
              },
              {
                id: "bypass-group",
                logic: "and",
                conditions: [
                  {
                    id: "bypass-rule",
                    field: "status",
                    fieldType: "string",
                    operator: "not_equals",
                    value: "confirmed",
                  },
                ],
              },
            ],
          }),
        },
      },
    };
    const filterInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredStartFilters: [
          {
            event: "applicant.created",
            filter: {
              groupLogic: "and",
              groups: [
                {
                  logic: "and",
                  rules: [
                    {
                      field: "status",
                      fieldType: "string",
                      operator: "equals",
                      value: "confirmed",
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };

    expect(assessScenarioSemantics(filterInput, document)).toEqual({
      score: 0,
      rationale:
        "applicant.created does not have the exact required Start Filter.",
    });
  });

  it("rejects graph edits for an unsupported request", () => {
    const preserveInput: AgentEvalInput = {
      ...input,
      expected: { preserveDocument: true },
    };

    expect(assessScenarioSemantics(preserveInput, completedDocument())).toEqual(
      {
        score: 0,
        rationale: "the workflow document changed.",
      }
    );
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

  it("rejects the wrong Condition group logic", () => {
    const document = completedDocument();
    document.nodes.push({
      id: "condition",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Both checks",
        type: "action",
        config: {
          actionType: "Condition",
          conditionModel: JSON.stringify({
            version: 2,
            groupLogic: "or",
            groups: [
              {
                id: "group",
                logic: "or",
                conditions: [
                  {
                    id: "rule",
                    field: "score",
                    fieldType: "number",
                    operator: "greater_than",
                    value: 70,
                  },
                ],
              },
            ],
          }),
        },
      },
    });
    const logicInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredConditionLogic: [
          {
            node: { kind: "action", actionId: "Condition" },
            groupLogic: "and",
            ruleLogic: "and",
          },
        ],
      },
    };

    expect(assessScenarioSemantics(logicInput, document)).toEqual({
      score: 0,
      rationale: "Condition does not use required and/and logic.",
    });
  });

  it("rejects a config that references the wrong output path", () => {
    const document = completedDocument();
    document.nodes.push({
      id: "issue",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Create issue",
        type: "action",
        config: {
          actionType: "linear/create-issue",
          title: "Score {{@score:Score applicant.score}}",
        },
      },
    });
    const referenceInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredReferences: [
          {
            node: { kind: "action", actionId: "linear/create-issue" },
            key: "title",
            path: "email",
          },
        ],
      },
    };

    expect(assessScenarioSemantics(referenceInput, document)).toEqual({
      score: 0,
      rationale: "linear/create-issue title does not reference email.",
    });
  });

  it("rejects duplicate branch messages when distinct values are required", () => {
    const document = completedDocument();
    document.nodes.push(
      {
        id: "first-notify",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "First message",
          type: "action",
          config: { actionType: "slack/send-message", text: "Same" },
        },
      },
      {
        id: "second-notify",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Second message",
          type: "action",
          config: { actionType: "slack/send-message", text: "Same" },
        },
      }
    );
    const distinctInput: AgentEvalInput = {
      ...input,
      expected: {
        distinctConfigValues: [
          {
            nodes: { kind: "action", actionId: "slack/send-message" },
            key: "text",
            count: 2,
          },
        ],
      },
    };

    expect(assessScenarioSemantics(distinctInput, document)).toEqual({
      score: 0,
      rationale: "slack/send-message needs 2 distinct text values, found 1.",
    });
  });
});
