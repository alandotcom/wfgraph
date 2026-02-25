import { describe, expect, it } from "bun:test";
import {
  type ConditionModel,
  compileConditionModel,
  createDefaultConditionModel,
  parseConditionModel,
  serializeConditionModel,
} from "@/workflow/conditions";

describe("conditions", () => {
  it("compiles grouped timestamp relative operators", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: "appointment.startsAt",
              fieldType: "timestamp",
              operator: "within_next",
              amount: 3,
              unit: "days",
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe(
        "((appointment.startsAt > now && appointment.startsAt < now + days(3)))"
      );
    }
  });

  it("compiles grouped timestamp absolute operators", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: "appointment.startsAt",
              fieldType: "timestamp",
              operator: "before",
              dateTime: "2026-03-01T10:00:00.000Z",
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe(
        '((appointment.startsAt < date("2026-03-01T10:00:00.000Z")))'
      );
    }
  });

  it("compiles multiple groups with group logic", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "or",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: "data.status",
              fieldType: "string",
              operator: "equals",
              value: "scheduled",
            },
            {
              id: "condition-2",
              field: "data.active",
              fieldType: "boolean",
              operator: "is_true",
            },
          ],
        },
        {
          id: "group-2",
          logic: "and",
          conditions: [
            {
              id: "condition-3",
              field: "data.count",
              fieldType: "number",
              operator: "greater_than",
              value: 5,
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe(
        '((data.status == "scheduled") && (data.active == true)) || ((data.count > 5))'
      );
    }
  });

  it("parses and serializes a valid condition model", () => {
    const defaultModel = createDefaultConditionModel(
      {
        path: "donor.lastDonation",
        label: "donor.lastDonation",
        type: "timestamp",
      },
      {
        groupId: "group-1",
        conditionId: "condition-1",
      }
    );

    const serialized = serializeConditionModel(defaultModel);
    const parsed = parseConditionModel(serialized);

    expect(parsed.valid).toBe(true);
    if (parsed.valid) {
      expect(parsed.model).toEqual(defaultModel);
    }
  });

  it("rejects malformed models", () => {
    const parsed = parseConditionModel(
      '{"version":2,"groupLogic":"and","groups":[]}'
    );
    expect(parsed.valid).toBe(false);
  });
});
