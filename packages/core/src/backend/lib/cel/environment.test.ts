import { describe, expect, it } from "bun:test";
import {
  checkCelBooleanExpression,
  evaluateCelBooleanExpression,
} from "@/backend/lib/cel/environment";

describe("CEL environment", () => {
  it("validates compiled timestamp expressions", () => {
    const validation = checkCelBooleanExpression(
      "appointment.startsAt > now && appointment.startsAt < now + days(3)"
    );

    expect(validation.ok).toBe(true);
  });

  it("evaluates timestamp comparisons", () => {
    const evaluation = evaluateCelBooleanExpression({
      expression:
        "appointment.startsAt > now && appointment.startsAt < now + days(3)",
      context: {
        now: new Date("2026-03-01T00:00:00.000Z"),
        appointment: {
          startsAt: new Date("2026-03-02T12:00:00.000Z"),
        },
      },
    });

    expect(evaluation.ok).toBe(true);
    if (evaluation.ok) {
      expect(evaluation.value).toBe(true);
    }
  });

  it("supports absolute date helper", () => {
    const evaluation = evaluateCelBooleanExpression({
      expression: 'appointment.startsAt > date("2026-03-01")',
      context: {
        now: new Date("2026-01-01T00:00:00.000Z"),
        appointment: {
          startsAt: new Date("2026-03-10T00:00:00.000Z"),
        },
      },
    });

    expect(evaluation.ok).toBe(true);
    if (evaluation.ok) {
      expect(evaluation.value).toBe(true);
    }
  });
});
