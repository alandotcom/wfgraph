/**
 * Graph builders for outline tests, and the seeded "Appointment reminders"
 * workflow the editor's review fixture holds, which the shared model test and
 * the editor's outline component test both read.
 */

import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import {
  type ConditionModel,
  type ConditionRule,
  serializeConditionModel,
} from "#src/conditions/conditions";
import type { EventMetadata, ExtensionCatalog } from "#src/extensions/catalog";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import { eventSplitOutlet } from "#src/lifecycle/event-split";
import type { LifecycleRules } from "#src/lifecycle/lifecycle-rules";
import { omitUndefined } from "#src/utils/omit-undefined";

export const CREATED = "app/appointment.created";
export const CANCELED = "app/appointment.canceled";
export const RESCHEDULED = "app/appointment.rescheduled";
export const SETTLED = "billing/payment.settled";

function anEvent(name: string, label: string): EventMetadata {
  return { name, label, payloadFields: [] };
}

export const outlineTestCatalog: ExtensionCatalog = {
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

export function lifecycle(rules: Partial<LifecycleRules>): WorkflowNode {
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

export function step(
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

export function wait(id: string, config: Record<string, unknown>, x = 0) {
  return step(id, {
    config: { actionType: BUILT_IN_ACTION_IDS.wait, ...config },
    x,
  });
}

export function group(id: string, x = 0): WorkflowNode {
  return {
    id,
    type: "group",
    position: { x, y: 0 },
    data: { label: id, type: "group" },
  };
}

export function rule(field: string, value: number): ConditionRule {
  return {
    id: `${field}-${value}`,
    field,
    fieldType: "number",
    operator: "greater_or_equal",
    value,
  };
}

export function condition(id: string, rules: ConditionRule[] = [rule("a", 1)]) {
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

export function edge(
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return { id: `${source}-${target}`, source, target, sourceHandle };
}

/** The seeded "Appointment reminders" workflow, as the editor's review fixture holds it. */
export function heroGraph(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
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
