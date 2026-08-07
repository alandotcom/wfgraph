import { describe, expect, it } from "vitest";
import { evaluateCompiledCondition } from "#src/backend/lib/cel/condition-payload";
import {
  type ConditionModel,
  type ConditionRule,
  compileConditionModel,
  EVENT_NAME_FIELD_PATH,
} from "@wfgraph/shared/conditions/conditions";
import type { JsonObject } from "@wfgraph/shared/types/json";

/**
 * The pair this file tests is compile-then-evaluate, because neither half states
 * the property on its own: the compiler emits a presence chain, and only CEL
 * decides what that chain does to the rule beside it.
 */
function evaluate(
  groups: ConditionRule[][],
  payload: JsonObject,
  eventName: string | null = null
) {
  const model: ConditionModel = {
    version: 2,
    groupLogic: "or",
    groups: groups.map((conditions, index) => ({
      id: `group-${index}`,
      logic: "and",
      conditions,
    })),
  };

  const compiled = compileConditionModel(model);
  if (!compiled.valid) {
    throw new Error(`Model did not compile: ${compiled.error}`);
  }

  return evaluateCompiledCondition({
    expression: compiled.expression,
    timestampPaths: [],
    payload,
    eventName,
  });
}

const cancelledPayload: JsonObject = {
  appointment: { id: "appt_123" },
  reason: "no_show",
};

describe("a compiled condition against a payload", () => {
  // The Events reaching one node declare different payloads, so a rule may name
  // a field this run never carried. That rule answers for itself; the condition
  // is still decided by the rules whose fields did arrive.
  it("reads a rule about an absent field as false without deciding the rest", () => {
    const evaluation = evaluate(
      [
        [
          {
            id: "rule-1",
            field: "rescheduledBy",
            fieldType: "string",
            operator: "equals",
            value: "patient",
          },
        ],
        [
          {
            id: "rule-2",
            field: "reason",
            fieldType: "string",
            operator: "equals",
            value: "no_show",
          },
        ],
      ],
      cancelledPayload
    );

    expect(evaluation.ok).toBe(true);
    if (evaluation.ok) {
      expect(evaluation.value).toBe(true);
    }
  });

  it("reads a rule about an absent field as false when it stands alone", () => {
    const evaluation = evaluate(
      [
        [
          {
            id: "rule-1",
            field: "rescheduledBy",
            fieldType: "string",
            operator: "equals",
            value: "patient",
          },
        ],
      ],
      cancelledPayload
    );

    expect(evaluation.ok).toBe(true);
    if (evaluation.ok) {
      expect(evaluation.value).toBe(false);
    }
  });

  // not_equals reads false as well: every rule asserts that the run carries the
  // field and that it satisfies the test.
  it("reads not_equals about an absent field as false", () => {
    const evaluation = evaluate(
      [
        [
          {
            id: "rule-1",
            field: "rescheduledBy",
            fieldType: "string",
            operator: "not_equals",
            value: "patient",
          },
        ],
      ],
      cancelledPayload
    );

    expect(evaluation.ok).toBe(true);
    if (evaluation.ok) {
      expect(evaluation.value).toBe(false);
    }
  });

  it("answers is_not_set for a path whose parent object never arrived", () => {
    const evaluation = evaluate(
      [
        [
          {
            id: "rule-1",
            field: "reschedule.by",
            fieldType: "string",
            operator: "is_not_set",
          },
        ],
      ],
      cancelledPayload
    );

    expect(evaluation.ok).toBe(true);
    if (evaluation.ok) {
      expect(evaluation.value).toBe(true);
    }
  });

  it("answers is_set for a nested path the payload carries", () => {
    const evaluation = evaluate(
      [
        [
          {
            id: "rule-1",
            field: "appointment.id",
            fieldType: "string",
            operator: "is_set",
          },
        ],
      ],
      cancelledPayload
    );

    expect(evaluation.ok).toBe(true);
    if (evaluation.ok) {
      expect(evaluation.value).toBe(true);
    }
  });

  // The whole point of the Event root: two Events reach one node, each carrying
  // its own fields, and the rule that answers is the one whose Event arrived.
  it("selects between Events by name, each reading its own field", () => {
    const groups: ConditionRule[][] = [
      [
        {
          id: "rule-1",
          field: EVENT_NAME_FIELD_PATH,
          fieldType: "string",
          operator: "equals",
          value: "appointment.rescheduled",
        },
        {
          id: "rule-2",
          field: "rescheduledBy",
          fieldType: "string",
          operator: "equals",
          value: "patient",
        },
      ],
      [
        {
          id: "rule-3",
          field: EVENT_NAME_FIELD_PATH,
          fieldType: "string",
          operator: "equals",
          value: "appointment.cancelled",
        },
        {
          id: "rule-4",
          field: "reason",
          fieldType: "string",
          operator: "equals",
          value: "no_show",
        },
      ],
    ];

    const cancelled = evaluate(
      groups,
      cancelledPayload,
      "appointment.cancelled"
    );
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.value).toBe(true);
    }

    const rescheduled = evaluate(
      groups,
      { appointment: { id: "appt_123" }, rescheduledBy: "clinic" },
      "appointment.rescheduled"
    );
    expect(rescheduled.ok).toBe(true);
    if (rescheduled.ok) {
      expect(rescheduled.value).toBe(false);
    }
  });

  // A manual start names no Event, and the root is written null rather than left
  // out: an absent root raises where a null one compares false.
  it("compares false for a run that arrived on no Event", () => {
    const evaluation = evaluate(
      [
        [
          {
            id: "rule-1",
            field: EVENT_NAME_FIELD_PATH,
            fieldType: "string",
            operator: "equals",
            value: "appointment.cancelled",
          },
        ],
      ],
      cancelledPayload,
      null
    );

    expect(evaluation.ok).toBe(true);
    if (evaluation.ok) {
      expect(evaluation.value).toBe(false);
    }
  });

  it("answers is_set false for a nested path the payload leaves out", () => {
    const evaluation = evaluate(
      [
        [
          {
            id: "rule-1",
            field: "appointment.newStartsAt",
            fieldType: "string",
            operator: "is_set",
          },
        ],
      ],
      cancelledPayload
    );

    expect(evaluation.ok).toBe(true);
    if (evaluation.ok) {
      expect(evaluation.value).toBe(false);
    }
  });
});
