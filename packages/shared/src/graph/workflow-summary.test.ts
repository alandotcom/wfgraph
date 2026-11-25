import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import {
  type ConditionModel,
  type ConditionRule,
  serializeConditionModel,
} from "#src/conditions/conditions";
import type { EventMetadata, ExtensionCatalog } from "#src/extensions/catalog";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import {
  conditionRulesPhrase,
  summarizeWorkflow,
  type WorkflowSummary,
  type WorkflowSummaryLine,
} from "#src/graph/workflow-summary";
import { eventSplitOutlet } from "#src/lifecycle/event-split";
import type { LifecycleRules } from "#src/lifecycle/lifecycle-rules";
import { omitUndefined } from "#src/utils/omit-undefined";

const CREATED = "app/appointment.created";
const CANCELED = "app/appointment.canceled";
const RESCHEDULED = "app/appointment.rescheduled";
const SETTLED = "billing/payment.settled";

function anEvent(name: string, label: string, paths: string[]): EventMetadata {
  return {
    name,
    label,
    payloadFields: paths.map((path) => ({ path, type: "string" as const })),
  };
}

const APPOINTMENT = [
  "appointment.id",
  "appointment.startsAt",
  "appointment.status",
];

const catalog: ExtensionCatalog = {
  entities: [],
  events: [
    anEvent(CREATED, "Appointment created", APPOINTMENT),
    anEvent(CANCELED, "Appointment canceled", [...APPOINTMENT, "reason"]),
    anEvent(RESCHEDULED, "Appointment rescheduled", APPOINTMENT),
    anEvent(SETTLED, "Payment settled", ["appointmentId", "amountCents"]),
  ],
  actions: [
    {
      id: "patients/send-message",
      label: "Send Patient Message",
      description: "",
      category: "Patients",
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [],
};

function lifecycle(rules: Partial<LifecycleRules>): WorkflowNode {
  return {
    id: "lifecycle",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Appointment booked",
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvents: [],
          cancelEvents: [],
          concurrency: "unlimited",
          allowManualStart: true,
          ...rules,
        },
      },
    },
  };
}

function step(
  id: string,
  config: Record<string, unknown> = { actionType: "patients/send-message" },
  options: { parentId?: string; label?: string; enabled?: boolean } = {}
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    ...omitUndefined({ parentId: options.parentId }),
    data: {
      label: options.label ?? id,
      type: "action",
      config,
      ...omitUndefined({ enabled: options.enabled }),
    },
  };
}

function group(id: string): WorkflowNode {
  return {
    id,
    type: "group",
    position: { x: 0, y: 0 },
    data: { label: id, type: "group", config: { direction: "vertical" } },
  };
}

function rule(field: string, value: number): ConditionRule {
  return {
    id: `${field}-${value}`,
    field,
    fieldType: "number",
    operator: "greater_or_equal",
    value,
  };
}

function condition(id: string, rules: ConditionRule[]): WorkflowNode {
  const model: ConditionModel = {
    version: 2,
    groupLogic: "and",
    groups: [{ id: `${id}-group`, logic: "and", conditions: rules }],
  };
  return step(id, {
    actionType: BUILT_IN_ACTION_IDS.condition,
    conditionModel: serializeConditionModel(model),
  });
}

function edge(
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return { id: `${source}-${target}`, source, target, sourceHandle };
}

function summarize(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowSummary {
  return summarizeWorkflow({ nodes, edges, catalog });
}

/** The lines as an indented outline, which is how a reader meets them. */
function outline(lines: readonly WorkflowSummaryLine[], indent = ""): string[] {
  return lines.flatMap((line) => [
    `${indent}${line.text}`,
    ...outline(line.children, `${indent}  `),
  ]);
}

describe("summarizeWorkflow", () => {
  it("reads a linear workflow as its steps in order, with each Wait's time", () => {
    const summary = summarize(
      [
        lifecycle({ startEvents: [CREATED] }),
        step("Send booking confirmation"),
        step("Pause", {
          actionType: BUILT_IN_ACTION_IDS.wait,
          waitMode: "delay",
          waitDuration: "1h 30m",
        }),
        step("Send reminder"),
      ],
      [
        edge("lifecycle", "Send booking confirmation", "started"),
        edge("Send booking confirmation", "Pause"),
        edge("Pause", "Send reminder"),
      ]
    );

    expect(summary.starts).toEqual([
      "Starts when Appointment created arrives.",
    ]);
    expect(outline(summary.steps)).toEqual([
      "Send booking confirmation",
      "Pause (waits 1 hour 30 minutes)",
      "Send reminder",
    ]);
    expect(summary.stops).toEqual([]);
  });

  it("writes a Start Filter in words and never a stored path", () => {
    const filter: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "g",
          logic: "and",
          conditions: [
            {
              id: "status",
              field: "appointment.status",
              fieldType: "string",
              operator: "is_one_of",
              values: ["scheduled", "confirmed"],
            },
            {
              id: "soon",
              field: "appointment.startsAt",
              fieldType: "timestamp",
              operator: "within_next",
              amount: 30,
              unit: "days",
            },
          ],
        },
      ],
    };
    const summary = summarize(
      [
        lifecycle({
          startEvents: [CREATED],
          startFilters: { [CREATED]: serializeConditionModel(filter) },
        }),
      ],
      []
    );

    expect(summary.starts).toEqual([
      "Starts when Appointment created arrives, if Status is one of scheduled or confirmed, and Starts at is within the next 30 days.",
    ]);
    expect(summary.steps).toEqual([]);
  });

  it("ends the run where a Condition's unwired branch would go, and folds a two-way Condition into its branches", () => {
    const summary = summarize(
      [
        lifecycle({ startEvents: [SETTLED] }),
        condition("Enough time?", [rule("a", 1), rule("b", 2)]),
        condition("Deposit covers the visit?", [rule("amountCents", 7500)]),
        step("Send deposit receipt"),
        step("Send intake form"),
        step("Release the slot"),
      ],
      [
        edge("lifecycle", "Enough time?", "started"),
        edge("Enough time?", "Deposit covers the visit?", "true"),
        edge("Deposit covers the visit?", "Send deposit receipt", "true"),
        edge("Send deposit receipt", "Send intake form"),
        edge("Deposit covers the visit?", "Release the slot", "false"),
      ]
    );

    expect(outline(summary.steps)).toEqual([
      "Checks “Enough time?” (all of 2 rules) and ends the run if False.",
      "Checks “Deposit covers the visit?”:",
      "  If True: Send deposit receipt, then Send intake form.",
      "  If False: Release the slot.",
    ]);
  });

  it("names a Group with its step count and carries on after it", () => {
    const summary = summarize(
      [
        lifecycle({ startEvents: [CREATED] }),
        group("Pre-visit reminders"),
        step(
          "Wait a day",
          { actionType: BUILT_IN_ACTION_IDS.wait },
          {
            parentId: "Pre-visit reminders",
          }
        ),
        step("Send reminder", undefined, { parentId: "Pre-visit reminders" }),
        step("Thank the patient"),
      ],
      [
        edge("lifecycle", "Wait a day", "started"),
        edge("Wait a day", "Send reminder"),
        edge("Send reminder", "Thank the patient"),
      ]
    );

    expect(outline(summary.steps)).toEqual([
      "Pre-visit reminders, a Group of 2 steps",
      "Thank the patient",
    ]);
  });

  it("writes an Event Split as one line per outlet, under side-by-side paths and an event Wait", () => {
    const summary = summarize(
      [
        lifecycle({ startEvents: [CREATED], cancelEvents: [CANCELED] }),
        step("Send booking confirmation"),
        step("Send reminder"),
        step("Wait for deposit or reschedule", {
          actionType: BUILT_IN_ACTION_IDS.wait,
          waitMode: "event",
          waitFor: [{ event: SETTLED }, { event: RESCHEDULED }],
          waitTimeout: "90d",
          waitTimeoutBehavior: "skip",
        }),
        step("Deposit or reschedule?", {
          actionType: BUILT_IN_ACTION_IDS.eventSplit,
        }),
        step("Send deposit receipt"),
        condition("Still wants reminders?", [rule("a", 1), rule("b", 2)]),
        step("Confirm the new time"),
        step("Send cancellation notice"),
      ],
      [
        edge("lifecycle", "Send booking confirmation", "started"),
        edge("lifecycle", "Send cancellation notice", "canceled"),
        edge("Send booking confirmation", "Send reminder"),
        edge("Send booking confirmation", "Wait for deposit or reschedule"),
        edge("Wait for deposit or reschedule", "Deposit or reschedule?"),
        edge(
          "Deposit or reschedule?",
          "Send deposit receipt",
          eventSplitOutlet(SETTLED)
        ),
        edge(
          "Deposit or reschedule?",
          "Still wants reminders?",
          eventSplitOutlet(RESCHEDULED)
        ),
        edge("Still wants reminders?", "Confirm the new time", "true"),
      ]
    );

    expect(outline(summary.steps)).toEqual([
      "Send booking confirmation",
      "Runs 2 paths at the same time:",
      "  Send reminder.",
      "  Wait for deposit or reschedule (waits up to 90 days for Payment settled or Appointment rescheduled, and ends the path if none arrives), then “Deposit or reschedule?” picks a path by the Event that arrived:",
      "    Payment settled: Send deposit receipt.",
      "    Appointment rescheduled: checks “Still wants reminders?” (all of 2 rules) and ends the path if False, then Confirm the new time.",
    ]);
    expect(summary.stops).toEqual([
      "Appointment canceled stops a run in progress.",
      "A stopped run then runs Send cancellation notice.",
    ]);
  });

  it("counts a branch nested past two levels instead of writing it out", () => {
    const summary = summarize(
      [
        lifecycle({ startEvents: [CREATED] }),
        step("A"),
        step("B"),
        step("C"),
        step("D"),
        step("E"),
        step("F"),
        step("G"),
      ],
      [
        edge("lifecycle", "A", "started"),
        edge("A", "B"),
        edge("A", "C"),
        edge("C", "D"),
        edge("C", "E"),
        edge("E", "F"),
        edge("E", "G"),
      ]
    );

    expect(outline(summary.steps)).toEqual([
      "A",
      "Runs 2 paths at the same time:",
      "  B.",
      "  C, then 2 paths run at the same time:",
      "    D.",
      "    E, then 2 paths run at the same time, across 2 steps.",
    ]);
  });

  it("continues once after side-by-side paths meet at a join", () => {
    const summary = summarize(
      [
        lifecycle({ startEvents: [CREATED] }),
        step("Look up patient"),
        step("Look up slot"),
        step("Send summary"),
      ],
      [
        edge("lifecycle", "Look up patient", "started"),
        edge("lifecycle", "Look up slot", "started"),
        edge("Look up patient", "Send summary"),
        edge("Look up slot", "Send summary"),
      ]
    );

    expect(outline(summary.steps)).toEqual([
      "Runs 2 paths at the same time:",
      "  Look up patient.",
      "  Look up slot.",
      "Send summary",
    ]);
  });

  it("ends a path at a disabled step", () => {
    const summary = summarize(
      [
        lifecycle({ startEvents: [CREATED] }),
        step("Send reminder", undefined, { enabled: false }),
        step("Never reached"),
      ],
      [
        edge("lifecycle", "Send reminder", "started"),
        edge("Send reminder", "Never reached"),
      ]
    );

    expect(outline(summary.steps)).toEqual([
      "Send reminder is disabled, so the run ends here.",
    ]);
  });

  it("reads a scheduled workflow's schedule in words", () => {
    const summary = summarize(
      [
        lifecycle({
          allowManualStart: false,
          schedules: [
            { cron: "0 7 * * 1", timeZone: "America/New_York" },
            { cron: "5 4 1-7 * *", timeZone: "UTC" },
          ],
        }),
      ],
      []
    );

    expect(summary.starts).toEqual([
      "Starts every Monday at 7:00 AM (America/New_York).",
      "Starts on the custom schedule 5 4 1-7 * * (UTC).",
    ]);
  });

  it("says what an empty workflow does, and names no id for an unlabelled step", () => {
    expect(summarize([lifecycle({})], [])).toEqual({
      starts: ["Starts only when someone runs it by hand."],
      steps: [],
      stops: [],
    });
    expect(
      summarize([lifecycle({ allowManualStart: false })], []).starts
    ).toEqual(["Nothing starts this workflow yet."]);

    const unlabelled = summarize(
      [
        lifecycle({ startEvents: [CREATED] }),
        step("node-1", { actionType: "gone/action" }, { label: "" }),
        step("node-2", {}, { label: "" }),
      ],
      [edge("lifecycle", "node-1", "started"), edge("node-1", "node-2")]
    );
    expect(outline(unlabelled.steps)).toEqual([
      "An action this app does not offer",
      "A step with no action chosen",
    ]);
  });

  it("keys each line uniquely among its siblings", () => {
    const summary = summarize(
      [
        lifecycle({ startEvents: [CREATED] }),
        step("a", undefined, { label: "Send reminder" }),
        step("b", undefined, { label: "Send reminder" }),
      ],
      [edge("lifecycle", "a", "started"), edge("lifecycle", "b", "started")]
    );
    const [paths] = summary.steps;

    expect(paths?.children.map((line) => line.key)).toEqual(["a", "b"]);
  });

  it("stops at a cycle instead of walking it again", () => {
    const summary = summarize(
      [lifecycle({ startEvents: [CREATED] }), step("A"), step("B")],
      [edge("lifecycle", "A", "started"), edge("A", "B"), edge("B", "A")]
    );

    expect(outline(summary.steps)).toEqual(["A", "B"]);
  });
});

describe("conditionRulesPhrase", () => {
  const modelConfig = (model: ConditionModel) => ({
    actionType: BUILT_IN_ACTION_IDS.condition,
    conditionModel: serializeConditionModel(model),
  });

  it("names how many rules must match when there is more than one", () => {
    expect(
      conditionRulesPhrase(
        modelConfig({
          version: 2,
          groupLogic: "and",
          groups: [
            { id: "g", logic: "or", conditions: [rule("a", 1), rule("b", 2)] },
          ],
        })
      )
    ).toBe("Any of 2 rules");
    expect(
      conditionRulesPhrase(
        modelConfig({
          version: 2,
          groupLogic: "and",
          groups: [
            { id: "g1", logic: "and", conditions: [rule("a", 1)] },
            { id: "g2", logic: "and", conditions: [rule("b", 2)] },
          ],
        })
      )
    ).toBe("All of 2 groups");
  });

  it("has nothing to say for one rule, no rules, or an unreadable model", () => {
    expect(
      conditionRulesPhrase(
        modelConfig({
          version: 2,
          groupLogic: "and",
          groups: [{ id: "g", logic: "and", conditions: [rule("a", 1)] }],
        })
      )
    ).toBeNull();
    expect(conditionRulesPhrase({})).toBeNull();
    expect(conditionRulesPhrase({ conditionModel: "{not json" })).toBeNull();
  });
});
