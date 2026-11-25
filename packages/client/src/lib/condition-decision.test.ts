import { describe, expect, it } from "vitest";
import {
  type ConditionModel,
  entityStateConditionPath,
  nodeOutputConditionPath,
} from "@wfgraph/shared/conditions/conditions";
import { conditionDecision } from "#src/lib/condition-decision";
import type { ExecutionLog } from "#src/lib/execution-logs";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

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
  nodes?: WorkflowNode[];
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
    nodes: input.nodes ?? [],
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

    expect(decision?.rules.get("rule_on")?.compared).toEqual({
      kind: "unrecorded",
    });
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
      compared: { kind: "unrecorded" },
      decisive: false,
    });
  });

  it("decides nothing for an execution that recorded no answer", () => {
    expect(
      conditionDecision({
        nodeId: "check",
        execution: log("check", undefined),
        config: null,
        nodes: [],
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

/**
 * The seeded "Deposit covers the visit?" Condition as two real runs recorded
 * it. Its Amount rule names the Lifecycle Node, which the engine reads below
 * the deposit Wait as the payload of the Payment settled Event that woke it;
 * the Lifecycle Node's own record holds the Appointment created payload, which
 * has no amount. Its Status rule names the booking confirmation's output.
 */
describe("conditionDecision on a seeded run's records", () => {
  const AMOUNT = nodeOutputConditionPath("booked", "amountCents") ?? "";
  const CONFIRMATION_STATUS =
    nodeOutputConditionPath("confirm", "status") ?? "";
  const DEPOSIT = model("and", [
    {
      id: "rule_amount",
      field: AMOUNT,
      fieldType: "number",
      operator: "greater_or_equal",
      value: 7500,
    },
    {
      id: "rule_status",
      field: CONFIRMATION_STATUS,
      fieldType: "string",
      operator: "not_equals",
      value: "failed",
    },
  ]);
  const NODES: WorkflowNode[] = [
    {
      id: "booked",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: { label: "Appointment booked", type: "lifecycle" },
    },
    ...["confirm", "deposit_wait", "split", "check"].map(
      (id): WorkflowNode => ({
        id,
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: id,
          type: "action",
          config:
            id === "deposit_wait"
              ? { actionType: "Wait", waitMode: "event" }
              : { actionType: "host/send" },
        },
      })
    ),
  ];
  const PATH: WorkflowEdge[] = [
    { id: "e1", source: "booked", target: "confirm", sourceHandle: "started" },
    { id: "e2", source: "confirm", target: "deposit_wait" },
    { id: "e3", source: "deposit_wait", target: "split" },
    {
      id: "e4",
      source: "split",
      target: "check",
      sourceHandle: "event:billing/payment.settled",
    },
    ...EDGES,
  ];
  const records = (amountCents: number) => [
    log("booked", {
      patientId: "pat_1008",
      appointment: { id: "appt_2008", status: "scheduled" },
    }),
    log("confirm", { success: true, data: { status: "sent" } }),
    log("deposit_wait", {
      waitType: "event",
      timedOut: false,
      hops: 0,
      event: "billing/payment.settled",
      payload: { appointmentId: "appt_2008", amountCents },
    }),
    log("split", { event: "billing/payment.settled" }),
  ];

  it("reads the amount from the Event that woke the Wait, and marks the rule that sent the run down False", () => {
    const decision = decide({
      answer: false,
      conditionModel: DEPOSIT,
      nodes: NODES,
      edges: PATH,
      logs: records(2500),
    });

    expect(decision?.rules.get("rule_amount")).toEqual({
      matched: false,
      compared: { kind: "value", value: 2500 },
      decisive: true,
    });
    expect(decision?.rules.get("rule_status")).toEqual({
      matched: true,
      compared: { kind: "value", value: "sent" },
      decisive: false,
    });
  });

  it("reads both rules as matched on the run that took True", () => {
    const decision = decide({
      answer: true,
      conditionModel: DEPOSIT,
      nodes: NODES,
      edges: PATH,
      logs: records(12_000),
    });

    expect(decision?.rules.get("rule_amount")).toEqual({
      matched: true,
      compared: { kind: "value", value: 12_000 },
      decisive: false,
    });
    expect(decision?.rules.get("rule_status")?.matched).toBe(true);
  });

  it("claims no verdict a value cannot stand behind", () => {
    // Values that would make the Condition answer True, beside a recorded
    // False, mean the records do not explain the answer.
    const decision = decide({
      answer: false,
      conditionModel: DEPOSIT,
      nodes: NODES,
      edges: PATH,
      logs: records(9000),
    });

    expect(decision?.rules.get("rule_amount")?.matched).toBeNull();
    expect(decision?.rules.get("rule_status")?.matched).toBeNull();
  });

  it("says a value was not recorded below the Canceled outlet, and set to nothing after a timeout", () => {
    const canceled = decide({
      answer: false,
      conditionModel: DEPOSIT,
      nodes: NODES,
      edges: [
        {
          id: "c1",
          source: "booked",
          target: "check",
          sourceHandle: "canceled",
        },
        ...EDGES,
      ],
      logs: records(2500),
    });
    expect(canceled?.rules.get("rule_amount")?.compared).toEqual({
      kind: "unrecorded",
    });

    // A Wait that gave up continues with no Event, which an Event Split would
    // stop at, so this Condition sits directly below the Wait.
    const timedOut = decide({
      answer: false,
      conditionModel: DEPOSIT,
      nodes: NODES,
      edges: [
        ...PATH.slice(0, 2),
        { id: "w", source: "deposit_wait", target: "check" },
        ...EDGES,
      ],
      logs: [
        ...records(2500).slice(0, 2),
        log("deposit_wait", { waitType: "event", timedOut: true, hops: 0 }),
      ],
    });
    expect(timedOut?.rules.get("rule_amount")?.compared).toEqual({
      kind: "missing",
    });
  });
});
