import { describe, expect, it } from "bun:test";
import {
  type ConditionModel,
  compileConditionModel,
  createDefaultConditionModel,
  parseConditionModel,
  serializeConditionModel,
} from "@/shared/workflow/conditions";

describe("conditions", () => {
  it("compiles timestamp relative operators", () => {
    const model: ConditionModel = {
      version: 1,
      field: "appointment.startsAt",
      fieldType: "timestamp",
      operator: "within_next",
      amount: 3,
      unit: "days",
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe(
        "appointment.startsAt > now && appointment.startsAt < now + days(3)"
      );
    }
  });

  it("compiles timestamp absolute operators", () => {
    const model: ConditionModel = {
      version: 1,
      field: "appointment.startsAt",
      fieldType: "timestamp",
      operator: "before",
      date: "2026-03-01",
    };

    const compiled = compileConditionModel(model);
    expect(compiled.valid).toBe(true);
    if (compiled.valid) {
      expect(compiled.expression).toBe(
        'appointment.startsAt < date("2026-03-01")'
      );
    }
  });

  it("parses and serializes a valid condition model", () => {
    const defaultModel = createDefaultConditionModel({
      path: "donor.lastDonation",
      label: "donor.lastDonation",
      type: "timestamp",
    });

    const serialized = serializeConditionModel(defaultModel);
    const parsed = parseConditionModel(serialized);

    expect(parsed.valid).toBe(true);
    if (parsed.valid) {
      expect(parsed.model).toEqual(defaultModel);
    }
  });

  it("rejects malformed models", () => {
    const parsed = parseConditionModel('{"version":1,"field":"x"}');
    expect(parsed.valid).toBe(false);
  });
});
