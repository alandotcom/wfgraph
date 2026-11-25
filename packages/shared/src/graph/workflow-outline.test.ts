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
  outlineRows,
  type OutlineRow,
  workflowOutline,
  type WorkflowOutline,
  workflowStepNumbers,
} from "#src/graph/workflow-outline";
import { eventSplitOutlet } from "#src/lifecycle/event-split";
import type { LifecycleRules } from "#src/lifecycle/lifecycle-rules";
import { omitUndefined } from "#src/utils/omit-undefined";

const CREATED = "app/appointment.created";
const CANCELED = "app/appointment.canceled";
const RESCHEDULED = "app/appointment.rescheduled";
const SETTLED = "billing/payment.settled";

function anEvent(name: string, label: string): EventMetadata {
  return { name, label, payloadFields: [] };
}

const catalog: ExtensionCatalog = {
  entities: [],
  events: [
    anEvent(CREATED, "Appointment created"),
    anEvent(CANCELED, "Appointment canceled"),
    anEvent(RESCHEDULED, "Appointment rescheduled"),
    anEvent(SETTLED, "Payment settled"),
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
  options: {
    config?: Record<string, unknown>;
    parentId?: string;
    label?: string;
    enabled?: boolean;
    x?: number;
  } = {}
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: options.x ?? 0, y: 0 },
    ...omitUndefined({ parentId: options.parentId }),
    data: {
      label: options.label ?? id,
      type: "action",
      config: options.config ?? { actionType: "patients/send-message" },
      ...omitUndefined({ enabled: options.enabled }),
    },
  };
}

function wait(id: string, config: Record<string, unknown>, x = 0) {
  return step(id, {
    config: { actionType: BUILT_IN_ACTION_IDS.wait, ...config },
    x,
  });
}

function group(id: string, x = 0): WorkflowNode {
  return {
    id,
    type: "group",
    position: { x, y: 0 },
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

function condition(id: string, rules: ConditionRule[] = [rule("a", 1)]) {
  const model: ConditionModel = {
    version: 2,
    groupLogic: "and",
    groups: [{ id: `${id}-group`, logic: "and", conditions: rules }],
  };
  return step(id, {
    config: {
      actionType: BUILT_IN_ACTION_IDS.condition,
      conditionModel: serializeConditionModel(model),
    },
  });
}

function edge(
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return { id: `${source}-${target}`, source, target, sourceHandle };
}

/** The rows as a reader meets them: indented, numbered, with the summary after a dot. */
function lines(rows: readonly OutlineRow[]): string[] {
  return rows.map((row) => {
    const indent = "  ".repeat(row.depth);
    switch (row.kind) {
      case "lifecycle":
        return `${indent}[start] ${row.label}${row.summary ? ` · ${row.summary}` : ""}`;
      case "step":
        return `${indent}${row.number ?? "-"} ${row.label}${row.summary ? ` · ${row.summary}` : ""}${row.disabled ? " [disabled]" : ""}`;
      case "group":
        return `${indent}[group] ${row.label} · ${row.summary}`;
      case "outlet":
        return `${indent}<${row.text}>`;
      case "parallel":
        return `${indent}<${row.text}>`;
      default:
        return `${indent}→ ${row.text}`;
    }
  });
}

function outline(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowOutline {
  return workflowOutline({ nodes, edges, catalog });
}

/** The seeded "Appointment reminders" workflow, as the editor's review fixture holds it. */
function heroGraph(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const reminders = "Pre-visit reminders";
  return {
    nodes: [
      lifecycle({ startEvents: [CREATED], cancelEvents: [CANCELED] }),
      condition("Enough time for reminders?", [rule("a", 1), rule("b", 2)]),
      step("Send booking confirmation"),
      group(reminders, 0),
      step("Wait until 24 hours before", {
        parentId: reminders,
        config: {
          actionType: BUILT_IN_ACTION_IDS.wait,
          waitMode: "delay",
          waitDuration: "1d",
        },
      }),
      step("Send 24-hour reminder", { parentId: reminders }),
      step("Wait until 2 hours before", {
        parentId: reminders,
        config: {
          actionType: BUILT_IN_ACTION_IDS.wait,
          waitMode: "delay",
          waitDuration: "2h",
        },
      }),
      step("Send 2-hour reminder", { parentId: reminders }),
      wait(
        "Wait for deposit or reschedule",
        {
          waitMode: "event",
          waitFor: [{ event: SETTLED }, { event: RESCHEDULED }],
          waitTimeout: "90d",
          waitTimeoutBehavior: "skip",
        },
        400
      ),
      step("Deposit or reschedule?", {
        config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
      }),
      condition("Deposit covers the visit?", [rule("a", 1), rule("b", 2)]),
      step("Send deposit receipt"),
      step("Send intake form"),
      step("Release the slot"),
      step("Alert the front desk"),
      condition("Patient still wants reminders?"),
      step("Confirm the new time"),
      step("Send cancellation notice"),
    ],
    edges: [
      edge("lifecycle", "Enough time for reminders?", "started"),
      edge("lifecycle", "Send cancellation notice", "canceled"),
      edge("Enough time for reminders?", "Send booking confirmation", "true"),
      edge("Send booking confirmation", "Wait until 24 hours before"),
      edge("Send booking confirmation", "Wait for deposit or reschedule"),
      edge("Wait until 24 hours before", "Send 24-hour reminder"),
      edge("Send 24-hour reminder", "Wait until 2 hours before"),
      edge("Wait until 2 hours before", "Send 2-hour reminder"),
      edge("Wait for deposit or reschedule", "Deposit or reschedule?"),
      edge(
        "Deposit or reschedule?",
        "Deposit covers the visit?",
        eventSplitOutlet(SETTLED)
      ),
      edge(
        "Deposit or reschedule?",
        "Patient still wants reminders?",
        eventSplitOutlet(RESCHEDULED)
      ),
      edge("Deposit covers the visit?", "Send deposit receipt", "true"),
      edge("Send deposit receipt", "Send intake form"),
      edge("Deposit covers the visit?", "Release the slot", "false"),
      edge("Release the slot", "Alert the front desk"),
      edge("Patient still wants reminders?", "Confirm the new time", "true"),
    ],
  };
}

describe("workflowOutline", () => {
  it("writes the seeded workflow in run order with every outlet as a labelled block", () => {
    const { nodes, edges } = heroGraph();
    const result = outline(nodes, edges);

    expect(lines(result.starts)).toEqual(["[start] Appointment created"]);
    expect(lines(result.steps)).toEqual([
      "1 If Enough time for reminders? · All of 2 rules",
      "  <If true>",
      "  2 Send booking confirmation · Send Patient Message",
      "    <At the same time>",
      "    [group] Pre-visit reminders · 4 steps",
      "      3 Wait until 24 hours before · Waits 1 day",
      "      4 Send 24-hour reminder · Send Patient Message",
      "      5 Wait until 2 hours before · Waits 2 hours",
      "      6 Send 2-hour reminder · Send Patient Message",
      "    <and>",
      "    7 Wait for deposit or reschedule · Waits up to 90 days for Payment settled or Appointment rescheduled, and ends the path if none arrives",
      "    8 Deposit or reschedule? · Picks a path by the Event that arrived",
      "      <When Payment settled>",
      "      9 If Deposit covers the visit? · All of 2 rules",
      "        <If true>",
      "        10 Send deposit receipt · Send Patient Message",
      "        11 Send intake form · Send Patient Message",
      "        <Otherwise>",
      "        12 Release the slot · Send Patient Message",
      "        13 Alert the front desk · Send Patient Message",
      "      <When Appointment rescheduled>",
      "      14 If Patient still wants reminders?",
      "        <If true>",
      "        15 Confirm the new time · Send Patient Message",
      "        <Otherwise, the path ends>",
      "  <Otherwise, the path ends>",
    ]);
    expect(lines(result.stops)).toEqual([
      "<Appointment canceled>",
      "16 Send cancellation notice · Send Patient Message",
    ]);
    expect(result.unconnected).toEqual([]);
  });

  it("says what each row sits under, so a fold hides the right rows", () => {
    const { nodes, edges } = heroGraph();
    const rows = outlineRows(outline(nodes, edges));
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const receipt = byKey.get("Send deposit receipt");
    const member = byKey.get("Send 24-hour reminder");

    expect(receipt?.parentKey).toBe("outlet:Deposit covers the visit?:true");
    expect(byKey.get("outlet:Deposit covers the visit?:true")?.parentKey).toBe(
      "Deposit covers the visit?"
    );
    expect(member?.parentKey).toBe("Pre-visit reminders");
    const otherwise = byKey.get("outlet:Deposit covers the visit?:false");
    expect(otherwise?.kind === "outlet" && otherwise.stepCount).toBe(2);
    expect(otherwise?.kind === "outlet" && otherwise.outletName).toBe("False");
  });

  it("numbers steps the way the rows do", () => {
    const { nodes, edges } = heroGraph();
    const numbers = workflowStepNumbers({ nodes, edges, catalog });

    expect(numbers.get("Enough time for reminders?")).toBe(1);
    expect(numbers.get("Send 2-hour reminder")).toBe(6);
    expect(numbers.get("Send cancellation notice")).toBe(16);
    expect(numbers.has("Pre-visit reminders")).toBe(false);
    expect(numbers.has("lifecycle")).toBe(false);
    expect(numbers.size).toBe(16);
  });

  it("lists a pure sequence one row per step at the top level", () => {
    const result = outline(
      [
        lifecycle({ startEvents: [CREATED] }),
        step("A"),
        wait("B", { waitMode: "delay", waitDuration: "1h 30m" }),
        step("C"),
      ],
      [edge("lifecycle", "A", "started"), edge("A", "B"), edge("B", "C")]
    );

    expect(lines(result.steps)).toEqual([
      "1 A · Send Patient Message",
      "2 B · Waits 1 hour 30 minutes",
      "3 C · Send Patient Message",
    ]);
    expect(result.stops).toEqual([]);
  });

  it("goes on at the outer depth after arms meet at a join", () => {
    const result = outline(
      [
        lifecycle({ startEvents: [CREATED] }),
        step("Fan out"),
        step("Look up patient", { x: 0 }),
        step("Look up slot", { x: 300 }),
        step("Send summary"),
      ],
      [
        edge("lifecycle", "Fan out", "started"),
        edge("Fan out", "Look up slot"),
        edge("Fan out", "Look up patient"),
        edge("Look up patient", "Send summary"),
        edge("Look up slot", "Send summary"),
      ]
    );

    expect(lines(result.steps)).toEqual([
      "1 Fan out · Send Patient Message",
      "  <At the same time>",
      "  2 Look up patient · Send Patient Message",
      "  <and>",
      "  3 Look up slot · Send Patient Message",
      "4 Send summary · Send Patient Message",
    ]);
  });

  it("writes a step reached from two places that do not nest once, and points at it from the other", () => {
    // Shared is reached from a Condition inside one arm and from the other
    // arm, so it is no join of the fan-out's arms.
    const result = outline(
      [
        lifecycle({ startEvents: [CREATED] }),
        step("Fan out"),
        step("X", { x: 0 }),
        { ...condition("Check"), position: { x: 0, y: 0 } },
        step("Y", { x: 300 }),
        step("Shared"),
      ],
      [
        edge("lifecycle", "Fan out", "started"),
        edge("Fan out", "X"),
        edge("Fan out", "Y"),
        edge("X", "Check"),
        edge("Check", "Shared", "true"),
        edge("Y", "Shared"),
      ]
    );

    expect(lines(result.steps)).toEqual([
      "1 Fan out · Send Patient Message",
      "  <At the same time>",
      "  2 X · Send Patient Message",
      "  3 If Check",
      "    <If true>",
      "    → Continues at step 4",
      "    <Otherwise, the path ends>",
      "  4 Shared · Send Patient Message",
      "  <and>",
      "  5 Y · Send Patient Message",
      "  → Continues at step 4",
    ]);
  });

  it("points back at a step a cycle returns to", () => {
    const result = outline(
      [lifecycle({ startEvents: [CREATED] }), step("A"), step("B")],
      [edge("lifecycle", "A", "started"), edge("A", "B"), edge("B", "A")]
    );

    expect(lines(result.steps)).toEqual([
      "1 A · Send Patient Message",
      "2 B · Send Patient Message",
      "→ Continues at step 1",
    ]);
  });

  it("holds a Group's members in its section and goes on after it", () => {
    const result = outline(
      [
        lifecycle({ startEvents: [CREATED] }),
        group("Reminders"),
        step("First", { parentId: "Reminders" }),
        step("Second", { parentId: "Reminders" }),
        step("After"),
      ],
      [
        edge("lifecycle", "First", "started"),
        edge("First", "Second"),
        edge("Second", "After"),
      ]
    );

    expect(lines(result.steps)).toEqual([
      "[group] Reminders · 2 steps",
      "  1 First · Send Patient Message",
      "  2 Second · Send Patient Message",
      "3 After · Send Patient Message",
    ]);
  });

  it("points a Condition outlet that leaves its Group at the step it reaches", () => {
    const result = outline(
      [
        lifecycle({ startEvents: [CREATED] }),
        group("Checks"),
        { ...condition("Inside"), parentId: "Checks" },
        step("Member", { parentId: "Checks" }),
        step("Outside"),
      ],
      [
        edge("lifecycle", "Inside", "started"),
        edge("Inside", "Member", "true"),
        edge("Inside", "Outside", "false"),
      ]
    );

    expect(lines(result.steps)).toEqual([
      "[group] Checks · 2 steps",
      "  1 If Inside",
      "    <If true>",
      "    2 Member · Send Patient Message",
      "    <Otherwise>",
      "    → Continues at step 3",
      "3 Outside · Send Patient Message",
    ]);
  });

  it("marks a disabled step and still lists what follows it", () => {
    const result = outline(
      [
        lifecycle({ startEvents: [CREATED] }),
        step("Off", { enabled: false }),
        step("After"),
      ],
      [edge("lifecycle", "Off", "started"), edge("Off", "After")]
    );

    expect(lines(result.steps)).toEqual([
      "1 Off · Send Patient Message [disabled]",
      "2 After · Send Patient Message",
    ]);
  });

  it("lists an Event Split outlet with nothing behind it as a path that ends", () => {
    const result = outline(
      [
        lifecycle({ startEvents: [CREATED, RESCHEDULED] }),
        step("Which one?", {
          config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
        }),
        step("Welcome"),
      ],
      [
        edge("lifecycle", "Which one?", "started"),
        edge("Which one?", "Welcome", eventSplitOutlet(CREATED)),
      ]
    );

    expect(lines(result.steps)).toEqual([
      "1 Which one? · Picks a path by the Event that arrived",
      "  <When Appointment created>",
      "  2 Welcome · Send Patient Message",
      "  <When Appointment rescheduled, the path ends>",
    ]);
  });

  it("opens an empty workflow with how it starts and lists no steps", () => {
    expect(lines(outlineRows(outline([lifecycle({})], [])))).toEqual([
      "[start] Someone runs it by hand",
    ]);
    expect(
      lines(outlineRows(outline([lifecycle({ allowManualStart: false })], [])))
    ).toEqual(["[start] Nothing starts it yet"]);
  });

  it("names an unlabelled step by its action and never by its id", () => {
    const result = outline(
      [
        lifecycle({ startEvents: [CREATED] }),
        step("node-1", { label: "" }),
        step("node-2", { label: "", config: {} }),
      ],
      [edge("lifecycle", "node-1", "started"), edge("node-1", "node-2")]
    );

    expect(lines(result.steps)).toEqual([
      "1 Send Patient Message",
      "2 A step with no action chosen",
    ]);
  });

  it("lists steps no path reaches after the rest, still numbered", () => {
    const result = outline(
      [lifecycle({ startEvents: [CREATED] }), step("A"), step("Loose")],
      [edge("lifecycle", "A", "started")]
    );

    expect(lines(result.unconnected)).toEqual([
      "2 Loose · Send Patient Message",
    ]);
  });

  it("shows the numbers it is given in place of its own", () => {
    const result = workflowOutline({
      nodes: [lifecycle({ startEvents: [CREATED] }), step("Gone"), step("A")],
      edges: [edge("lifecycle", "Gone", "started"), edge("Gone", "A")],
      catalog,
      numberOf: new Map([["A", 1]]),
    });

    expect(lines(result.steps)).toEqual([
      "- Gone · Send Patient Message",
      "1 A · Send Patient Message",
    ]);
  });
});
