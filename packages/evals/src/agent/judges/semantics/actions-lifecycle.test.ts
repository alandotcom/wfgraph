import { describe, expect, it } from "vitest";
import type { AgentEvalInput } from "#src/agent/types";
import { assessScenarioSemantics } from "#src/agent/judges/semantics";
import { completedDocument, input } from "#src/agent/judges/semantics/fixtures";

describe("assessScenarioSemantics", () => {
  it("rejects the wrong count when a scenario declares exact actions", () => {
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

  it("does not count a disabled action toward an exact action expectation", () => {
    const document = completedDocument();
    const score = document.nodes[1];
    if (!score) {
      throw new Error("Score fixture is missing");
    }
    score.data.enabled = false;
    const exactInput: AgentEvalInput = {
      ...input,
      expected: { exactActions: { "score-applicant": 1 } },
    };

    expect(assessScenarioSemantics(exactInput, document)).toEqual({
      score: 0,
      rationale: "Expected exactly 1 score-applicant node, found 0.",
    });
  });

  it("rejects an action outside the exact action multiset", () => {
    const document = completedDocument();
    document.nodes.push({
      id: "unexpected-action",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Unexpected",
        type: "action",
        config: { actionType: "crm/get-applicant" },
      },
    });
    const exactInput: AgentEvalInput = {
      ...input,
      expected: { exactActions: { "score-applicant": 1 } },
    };

    expect(assessScenarioSemantics(exactInput, document)).toEqual({
      score: 0,
      rationale: "unexpected action crm/get-applicant is present.",
    });
  });

  it("accepts an exact Event set in a different order", () => {
    const document = completedDocument();
    const lifecycle = document.nodes[0];
    if (!lifecycle) {
      throw new Error("Lifecycle fixture is missing");
    }
    lifecycle.data.config = {
      lifecycleRules: {
        startEvents: ["applicant.updated", "applicant.created"],
        cancelEvents: ["applicant.withdrawn", "applicant.deleted"],
        concurrency: "unlimited",
      },
    };
    const eventsInput: AgentEvalInput = {
      ...input,
      expected: {
        exactEvents: {
          start: ["applicant.created", "applicant.updated"],
          cancel: ["applicant.deleted", "applicant.withdrawn"],
        },
      },
    };

    expect(assessScenarioSemantics(eventsInput, document)).toMatchObject({
      score: 1,
    });
  });

  it("rejects missing and unexpected Events in an exact Event set", () => {
    const document = completedDocument();
    const lifecycle = document.nodes[0];
    if (!lifecycle) {
      throw new Error("Lifecycle fixture is missing");
    }
    lifecycle.data.config = {
      lifecycleRules: {
        startEvents: ["applicant.created", "applicant.updated"],
        cancelEvents: [],
        concurrency: "unlimited",
      },
    };
    const eventsInput: AgentEvalInput = {
      ...input,
      expected: {
        exactEvents: {
          start: ["applicant.created"],
          cancel: ["applicant.withdrawn"],
        },
      },
    };

    expect(assessScenarioSemantics(eventsInput, document)).toEqual({
      score: 0,
      rationale:
        "Start Events must be exactly applicant.created, found applicant.created, applicant.updated; Cancel Events must be exactly applicant.withdrawn, found none.",
    });
  });

  it("rejects changed lifecycle settings that a scenario requires", () => {
    const document = completedDocument();
    const lifecycleInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredLifecycleRules: {
          concurrency: "newest-wins",
          allowManualStart: true,
          correlationPaths: { "applicant.created": "applicantId" },
          connectionIds: { "applicant.created": "connection-1" },
        },
      },
    };

    expect(assessScenarioSemantics(lifecycleInput, document)).toEqual({
      score: 0,
      rationale:
        "Lifecycle concurrency must be newest-wins; Lifecycle manual start must be enabled; Lifecycle Correlation Paths do not include the required values; Lifecycle Connections do not include the required values.",
    });
  });

  it("accepts the required tracked Entity and eligibility condition", () => {
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
        trackedEntity: {
          type: "applicant",
          bindings: { "applicant.created": "applicant" },
        },
        entityEligibility: {
          checkpoints: ["before-node", "before-execution"],
          condition: JSON.stringify({
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
                    operator: "is_one_of",
                    values: ["active", "paused"],
                  },
                ],
              },
            ],
          }),
        },
      },
    };
    const lifecycleInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredLifecycleRules: {
          trackedEntity: {
            type: "applicant",
            bindings: { "applicant.created": "applicant" },
          },
          entityEligibility: {
            checkpoints: ["before-execution", "before-node"],
            condition: {
              groupLogic: "and",
              groups: [
                {
                  logic: "and",
                  rules: [
                    {
                      field: "status",
                      fieldType: "string",
                      operator: "is_one_of",
                      values: ["active", "paused"],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    };

    expect(assessScenarioSemantics(lifecycleInput, document)).toMatchObject({
      score: 1,
    });
  });

  it("accepts a set eligibility condition with its values in a different order", () => {
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
        trackedEntity: {
          type: "applicant",
          bindings: { "applicant.created": "applicant" },
        },
        entityEligibility: {
          checkpoints: ["before-execution"],
          // The graph lists the eligible statuses as paused, then active.
          condition: JSON.stringify({
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
                    operator: "is_one_of",
                    values: ["paused", "active"],
                  },
                ],
              },
            ],
          }),
        },
      },
    };
    const lifecycleInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredLifecycleRules: {
          entityEligibility: {
            checkpoints: ["before-execution"],
            // The scenario requires the same statuses, active then paused.
            // Membership is the same set, so the comparison must still score
            // a match.
            condition: {
              groupLogic: "and",
              groups: [
                {
                  logic: "and",
                  rules: [
                    {
                      field: "status",
                      fieldType: "string",
                      operator: "is_one_of",
                      values: ["active", "paused"],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    };

    expect(assessScenarioSemantics(lifecycleInput, document)).toMatchObject({
      score: 1,
    });
  });

  it("accepts a set eligibility condition with a duplicate value", () => {
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
        trackedEntity: {
          type: "applicant",
          bindings: { "applicant.created": "applicant" },
        },
        entityEligibility: {
          checkpoints: ["before-execution"],
          // The graph repeats "active". A repeated value does not change
          // which statuses are eligible, so the comparison must still score
          // a match against a requirement with no repeat.
          condition: JSON.stringify({
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
                    operator: "is_one_of",
                    values: ["active", "paused", "active"],
                  },
                ],
              },
            ],
          }),
        },
      },
    };
    const lifecycleInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredLifecycleRules: {
          entityEligibility: {
            checkpoints: ["before-execution"],
            condition: {
              groupLogic: "and",
              groups: [
                {
                  logic: "and",
                  rules: [
                    {
                      field: "status",
                      fieldType: "string",
                      operator: "is_one_of",
                      values: ["paused", "active"],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    };

    expect(assessScenarioSemantics(lifecycleInput, document)).toMatchObject({
      score: 1,
    });
  });

  it("rejects a set eligibility condition with a duplicate value but a different member", () => {
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
        trackedEntity: {
          type: "applicant",
          bindings: { "applicant.created": "applicant" },
        },
        entityEligibility: {
          checkpoints: ["before-execution"],
          // The graph repeats "active", but also lists "cancelled", which
          // lifecycleInput does not require. Deduplication must not hide
          // that mismatch.
          condition: JSON.stringify({
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
                    operator: "is_one_of",
                    values: ["active", "active", "cancelled"],
                  },
                ],
              },
            ],
          }),
        },
      },
    };
    const lifecycleInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredLifecycleRules: {
          entityEligibility: {
            checkpoints: ["before-execution"],
            condition: {
              groupLogic: "and",
              groups: [
                {
                  logic: "and",
                  rules: [
                    {
                      field: "status",
                      fieldType: "string",
                      operator: "is_one_of",
                      values: ["active", "paused"],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    };

    expect(assessScenarioSemantics(lifecycleInput, document)).toEqual({
      score: 0,
      rationale:
        "Lifecycle Entity Eligibility does not match the required checkpoints and condition.",
    });
  });

  it("rejects a set eligibility condition missing a required member", () => {
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
        trackedEntity: {
          type: "applicant",
          bindings: { "applicant.created": "applicant" },
        },
        entityEligibility: {
          checkpoints: ["before-execution"],
          // "cancelled" is not one of the statuses lifecycleInput requires.
          condition: JSON.stringify({
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
                    operator: "is_one_of",
                    values: ["paused", "cancelled"],
                  },
                ],
              },
            ],
          }),
        },
      },
    };
    const lifecycleInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredLifecycleRules: {
          entityEligibility: {
            checkpoints: ["before-execution"],
            condition: {
              groupLogic: "and",
              groups: [
                {
                  logic: "and",
                  rules: [
                    {
                      field: "status",
                      fieldType: "string",
                      operator: "is_one_of",
                      values: ["active", "paused"],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    };

    expect(assessScenarioSemantics(lifecycleInput, document)).toEqual({
      score: 0,
      rationale:
        "Lifecycle Entity Eligibility does not match the required checkpoints and condition.",
    });
  });

  it("rejects duplicate eligibility checkpoints", () => {
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
        trackedEntity: {
          type: "applicant",
          bindings: { "applicant.created": "applicant" },
        },
        entityEligibility: {
          checkpoints: ["before-execution", "before-node", "before-node"],
          condition: JSON.stringify({
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
                    value: "active",
                  },
                ],
              },
            ],
          }),
        },
      },
    };
    const lifecycleInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredLifecycleRules: {
          entityEligibility: {
            checkpoints: ["before-execution", "before-node"],
            condition: {
              groupLogic: "and",
              groups: [
                {
                  logic: "and",
                  rules: [
                    {
                      field: "status",
                      fieldType: "string",
                      operator: "equals",
                      value: "active",
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    };

    expect(assessScenarioSemantics(lifecycleInput, document)).toEqual({
      score: 0,
      rationale:
        "Lifecycle Entity Eligibility does not match the required checkpoints and condition.",
    });
  });

  it("requires tracking without eligibility when the scenario says so", () => {
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
        trackedEntity: {
          type: "applicant",
          bindings: { "applicant.created": "applicant" },
        },
        entityEligibility: {
          checkpoints: ["before-execution"],
          condition: JSON.stringify({
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
                    value: "active",
                  },
                ],
              },
            ],
          }),
        },
      },
    };
    const lifecycleInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredLifecycleRules: {
          trackedEntity: {
            type: "applicant",
            bindings: { "applicant.created": "applicant" },
          },
          entityEligibility: null,
        },
      },
    };

    expect(assessScenarioSemantics(lifecycleInput, document)).toEqual({
      score: 0,
      rationale:
        "Lifecycle must track the Entity without an eligibility condition.",
    });
  });

  it("allows additional lifecycle map entries required by the requested edit", () => {
    const document = completedDocument();
    const lifecycle = document.nodes[0];
    if (!lifecycle) {
      throw new Error("Lifecycle fixture is missing");
    }
    lifecycle.data.config = {
      lifecycleRules: {
        startEvents: ["applicant.created"],
        cancelEvents: ["applicant.withdrawn"],
        concurrency: "newest-wins",
        correlationPaths: {
          "applicant.created": "applicantId",
          "applicant.withdrawn": "applicantId",
        },
      },
    };
    const lifecycleInput: AgentEvalInput = {
      ...input,
      expected: {
        requiredLifecycleRules: {
          concurrency: "newest-wins",
          correlationPaths: { "applicant.created": "applicantId" },
        },
      },
    };

    expect(assessScenarioSemantics(lifecycleInput, document)).toMatchObject({
      score: 1,
    });
  });

  it("includes Events from every Lifecycle node in an exact Event set", () => {
    const document = completedDocument();
    document.nodes.push({
      id: "second-entry",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: {
        label: "Second lifecycle",
        type: "lifecycle",
        config: {
          lifecycleRules: {
            startEvents: ["applicant.updated"],
            cancelEvents: [],
            concurrency: "unlimited",
          },
        },
      },
    });

    expect(assessScenarioSemantics(input, document)).toEqual({
      score: 0,
      rationale:
        "Start Events must be exactly applicant.created, found applicant.created, applicant.updated.",
    });
  });

  it("does not let a disabled Lifecycle node satisfy Event, Start Filter, or flow requirements", () => {
    const document = completedDocument();
    const lifecycle = document.nodes[0];
    if (!lifecycle) {
      throw new Error("Lifecycle fixture is missing");
    }
    lifecycle.data.enabled = false;
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
                    value: "confirmed",
                  },
                ],
              },
            ],
          }),
        },
      },
    };
    const lifecycleInput: AgentEvalInput = {
      ...input,
      expected: {
        exactEvents: { start: ["applicant.created"], cancel: [] },
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
        requiredFlows: [
          {
            source: { kind: "lifecycle" },
            target: { kind: "action", actionId: "score-applicant" },
            sourceHandle: "started",
          },
        ],
      },
    };

    expect(assessScenarioSemantics(lifecycleInput, document)).toEqual({
      score: 0,
      rationale:
        "Start Events must be exactly applicant.created, found none; applicant.created does not have the exact required Start Filter; missing required flow lifecycle -> score-applicant through started.",
    });
  });

  it("finds a Start Filter on the Lifecycle node that declares its Event", () => {
    const document = completedDocument();
    const lifecycle = document.nodes[0];
    if (!lifecycle) {
      throw new Error("Lifecycle fixture is missing");
    }
    lifecycle.data.config = {
      lifecycleRules: {
        startEvents: [],
        cancelEvents: [],
        concurrency: "unlimited",
      },
    };
    document.nodes.push({
      id: "filtered-entry",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: {
        label: "Filtered lifecycle",
        type: "lifecycle",
        config: {
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
                        value: "confirmed",
                      },
                    ],
                  },
                ],
              }),
            },
          },
        },
      },
    });
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

    expect(assessScenarioSemantics(filterInput, document)).toMatchObject({
      score: 1,
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

  it("rejects a Cancel Filter rule with the wrong value", () => {
    const document = completedDocument();
    const lifecycle = document.nodes[0];
    if (!lifecycle) {
      throw new Error("Lifecycle fixture is missing");
    }
    lifecycle.data.config = {
      lifecycleRules: {
        startEvents: ["applicant.created"],
        cancelEvents: ["applicant.withdrawn"],
        concurrency: "unlimited",
        cancelFilters: {
          "applicant.withdrawn": JSON.stringify({
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
                    value: "other-applicant",
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
        requiredCancelFilters: [
          {
            event: "applicant.withdrawn",
            filter: {
              groupLogic: "and",
              groups: [
                {
                  logic: "and",
                  rules: [
                    {
                      field: "applicantId",
                      fieldType: "string",
                      operator: "equals",
                      value: "expected-applicant",
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
        "applicant.withdrawn does not have the exact required Cancel Filter.",
    });
  });
});
