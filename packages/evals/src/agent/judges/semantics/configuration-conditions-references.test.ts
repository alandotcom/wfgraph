import { describe, expect, it } from "vitest";
import { serializeConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import type { AgentEvalInput } from "#src/agent/types";
import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import { assessScenarioSemantics } from "#src/agent/judges/semantics";
import { completedDocument, input } from "#src/agent/judges/semantics/fixtures";

describe("assessScenarioSemantics", () => {
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

  it("rejects a required config that only a disabled matching action has", () => {
    const document = completedDocument();
    document.nodes.push(
      {
        id: "enabled-notify",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Notify recruiting",
          type: "action",
          config: { actionType: "slack/send-message", text: "Wrong text" },
        },
      },
      {
        id: "disabled-notify",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Notify recruiting later",
          type: "action",
          enabled: false,
          config: {
            actionType: "slack/send-message",
            text: "Expected text",
          },
        },
      }
    );
    const configInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredConfigs: [
          {
            node: { kind: "action", actionId: "slack/send-message" },
            values: { text: "Expected text" },
          },
        ],
      },
    };

    expect(assessScenarioSemantics(configInput, document)).toEqual({
      score: 0,
      rationale: "slack/send-message does not have required config text.",
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

  it("accepts an exact Wait match and Event Connection", () => {
    const document = completedDocument();
    document.nodes.push({
      id: "wait",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Wait for the same applicant",
        type: "action",
        config: {
          actionType: "Wait",
          waitMode: "event",
          waitFor: [
            {
              event: "slack/message.received",
              connectionId: "slack-primary",
              match: serializeConditionModel({
                version: 2,
                groupLogic: "and",
                groups: [
                  {
                    id: "group",
                    logic: "and",
                    conditions: [
                      {
                        id: "rule",
                        field: "applicantId",
                        fieldType: "string",
                        operator: "equals",
                        value: "{{@entry:Lifecycle.applicantId}}",
                      },
                    ],
                  },
                ],
              }),
            },
          ],
        },
      },
    });
    document.edges.push({
      id: "score-wait",
      source: "score",
      target: "wait",
    });
    const waitInput: AgentEvalInput = {
      ...input,
      catalog: fixtureCatalog,
      expected: {
        requiredWaitSubscriptions: [
          {
            node: { kind: "action", actionId: "Wait" },
            event: "slack/message.received",
            connectionId: "slack-primary",
            matchRule: {
              field: "applicantId",
              operator: "equals",
              referencePath: "applicantId",
            },
          },
        ],
      },
    };

    expect(assessScenarioSemantics(waitInput, document)).toEqual({
      score: 1,
      rationale: "The graph satisfies the scenario constraints.",
    });
  });

  it("rejects a Wait subscription with the wrong Connection", () => {
    const document = completedDocument();
    document.nodes.push({
      id: "wait",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Wait for Slack",
        type: "action",
        config: {
          actionType: "Wait",
          waitMode: "event",
          waitFor: [
            {
              event: "slack/message.received",
              connectionId: "slack-secondary",
            },
          ],
        },
      },
    });
    const waitInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredWaitSubscriptions: [
          {
            node: { kind: "action", actionId: "Wait" },
            event: "slack/message.received",
            connectionId: "slack-primary",
          },
        ],
      },
    };

    expect(assessScenarioSemantics(waitInput, document)).toEqual({
      score: 0,
      rationale:
        "Wait does not have the required subscription for slack/message.received.",
    });
  });

  it("rejects a Wait match that invents an upstream reference", () => {
    const document = completedDocument();
    document.nodes.push({
      id: "wait",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Wait for the same applicant",
        type: "action",
        config: {
          actionType: "Wait",
          waitMode: "event",
          waitFor: [
            {
              event: "applicant.withdrawn",
              match: serializeConditionModel({
                version: 2,
                groupLogic: "and",
                groups: [
                  {
                    id: "group",
                    logic: "and",
                    conditions: [
                      {
                        id: "rule",
                        field: "applicantId",
                        fieldType: "string",
                        operator: "equals",
                        value: "{{@missing:Missing.applicantId}}",
                      },
                    ],
                  },
                ],
              }),
            },
          ],
        },
      },
    });
    const waitInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredWaitSubscriptions: [
          {
            node: { kind: "action", actionId: "Wait" },
            event: "applicant.withdrawn",
            matchRule: {
              field: "applicantId",
              operator: "equals",
              referencePath: "applicantId",
            },
          },
        ],
      },
    };

    expect(assessScenarioSemantics(waitInput, document)).toEqual({
      score: 0,
      rationale:
        "Wait does not have the required subscription for applicant.withdrawn.",
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

  it("rejects a template reference grounded by a disabled Lifecycle node", () => {
    const document = completedDocument();
    const lifecycle = document.nodes[0];
    if (!lifecycle) {
      throw new Error("Lifecycle fixture is missing");
    }
    document.nodes.push({
      id: "notify",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Notify recruiting",
        type: "action",
        config: {
          actionType: "slack/send-message",
          text: "{{@entry:Lifecycle.email}}",
        },
      },
    });
    const referenceInput: AgentEvalInput = {
      ...input,
      catalog: {
        ...input.catalog,
        events: [
          {
            name: "applicant.created",
            label: "Applicant created",
            integration: "applicant",
            payloadFields: [{ path: "email", type: "string" }],
          },
        ],
      },
      expected: {
        requiredReferences: [
          {
            node: { kind: "action", actionId: "slack/send-message" },
            key: "text",
            path: "email",
          },
        ],
      },
    };

    expect(assessScenarioSemantics(referenceInput, document)).toEqual({
      score: 1,
      rationale: "The graph satisfies the scenario constraints.",
    });

    lifecycle.data.enabled = false;

    expect(assessScenarioSemantics(referenceInput, document)).toEqual({
      score: 0,
      rationale: "slack/send-message text does not reference email.",
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
