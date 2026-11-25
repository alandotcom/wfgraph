import { describe, expect, it } from "vitest";
import {
  type ConditionModel,
  entityStateConditionPath,
  nodeOutputConditionPath,
} from "@wfgraph/shared/conditions/conditions";
import { conditionDecision } from "#src/lib/condition-decision";
import type { ExecutionLog } from "#src/lib/execution-logs";
import type { WorkflowEdge } from "#src/lib/workflow-graph-types";

function log(
  nodeId: string,
  output: unknown,
  startedAt = "2026-03-01T10:00:00Z"
): ExecutionLog {
  return {
    id: `log_${nodeId}_${startedAt}`,
    nodeId,
    nodeName: nodeId,
    nodeType: "action",
    status: "success",
    startedAt: new Date(startedAt),
    completedAt: null,
    duration: null,
    output,
    error: null,
    retries: 0,
    retryLimit: 3,
  };
}

const VISIT_AHEAD = nodeOutputConditionPath("lookup", "visit.daysAhead") ?? "";
const REMINDERS_ON = nodeOutputConditionPath("lookup", "remindersOn") ?? "";
const PATIENT_STATUS =
  entityStateConditionPath("patient", "appointment.status") ?? "";

function model(
  logic: "and" | "or",
  rules: ConditionModel["groups"][number]["conditions"]
): ConditionModel {
  return {
    version: 2,
    groupLogic: "and",
    groups: [{ id: "group_1", logic, conditions: rules }],
  };
}

const TWO_RULES = model("and", [
  {
    id: "rule_on",
    field: REMINDERS_ON,
    fieldType: "boolean",
    operator: "is_true",
  },
  {
    id: "rule_ahead",
    field: VISIT_AHEAD,
    fieldType: "number",
    operator: "greater_than",
    value: 1,
  },
]);

const EDGES: WorkflowEdge[] = [
  { id: "e_true", source: "check", target: "remind", sourceHandle: "true" },
  { id: "e_false", source: "check", target: "notify", sourceHandle: "false" },
];

function decide(input: {
  answer: boolean;
  conditionModel: ConditionModel | null;
  logs?: ExecutionLog[];
  edges?: WorkflowEdge[];
}) {
  const execution = log(
    "check",
    { condition: input.answer },
    "2026-03-01T10:00:05Z"
  );
  return conditionDecision({
    nodeId: "check",
    execution,
    config:
      input.conditionModel === null
        ? {}
        : { conditionModel: JSON.stringify(input.conditionModel) },
    edges: input.edges ?? EDGES,
    logs: [...(input.logs ?? []), execution],
  });
}

describe("conditionDecision", () => {
  it("names the branch the answer took and the steps it connects to", () => {
    const decision = decide({ answer: false, conditionModel: TWO_RULES });

    expect(decision?.branch).toBe("false");
    expect(decision?.continuesTo).toEqual(["notify"]);
  });

  it("connects to nothing where the taken branch ends the path", () => {
    const decision = decide({
      answer: true,
      conditionModel: TWO_RULES,
      edges: [EDGES[1] as WorkflowEdge],
    });

    expect(decision?.continuesTo).toEqual([]);
  });

  it("reads each rule as matched when an all-rules group answered True", () => {
    const decision = decide({ answer: true, conditionModel: TWO_RULES });

    expect(decision?.rules.get("rule_on")?.matched).toBe(true);
    expect(decision?.rules.get("rule_ahead")?.matched).toBe(true);
  });

  it("leaves each rule unknown when an all-rules group answered False", () => {
    const decision = decide({ answer: false, conditionModel: TWO_RULES });

    expect(decision?.rules.get("rule_on")?.matched).toBeNull();
  });

  it("reads each rule as not matched when an any-rule group answered False", () => {
    const anyRule = model("or", TWO_RULES.groups[0]?.conditions ?? []);
    const decision = decide({ answer: false, conditionModel: anyRule });

    expect(decision?.rules.get("rule_on")?.matched).toBe(false);
    expect(decision?.rules.get("rule_ahead")?.matched).toBe(false);
  });

  it("reads the value a rule compared from the step output it names", () => {
    const decision = decide({
      answer: false,
      conditionModel: TWO_RULES,
      logs: [
        log("lookup", { success: true, data: { visit: { daysAhead: 0 } } }),
      ],
    });

    expect(decision?.rules.get("rule_ahead")?.compared).toEqual({
      kind: "value",
      value: 0,
    });
    expect(decision?.rules.get("rule_on")?.compared).toEqual({
      kind: "missing",
    });
  });

  it("ignores an output the step recorded after the Condition ran", () => {
    const decision = decide({
      answer: false,
      conditionModel: TWO_RULES,
      logs: [log("lookup", { remindersOn: true }, "2026-03-01T10:00:09Z")],
    });

    expect(decision?.rules.get("rule_on")?.compared).toBeNull();
  });

  it("holds no compared value for a rule on Entity State", () => {
    const decision = decide({
      answer: true,
      conditionModel: model("and", [
        {
          id: "rule_status",
          field: PATIENT_STATUS,
          fieldType: "string",
          operator: "equals",
          value: "booked",
        },
      ]),
    });

    expect(decision?.rules.get("rule_status")).toEqual({
      matched: true,
      compared: null,
    });
  });

  it("decides nothing for an execution that recorded no answer", () => {
    expect(
      conditionDecision({
        nodeId: "check",
        execution: log("check", undefined),
        config: null,
        edges: EDGES,
        logs: [],
      })
    ).toBeNull();
  });

  it("keeps the branch when the stored rules cannot be read", () => {
    const decision = decide({ answer: true, conditionModel: null });

    expect(decision?.model).toBeNull();
    expect(decision?.branch).toBe("true");
  });
});
