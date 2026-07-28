import { describe, expect, it } from "vitest";
import {
  checkCelBooleanExpression,
  evaluateCelBooleanExpression,
} from "@/backend/lib/cel/environment";

describe("CEL environment", () => {
  it("validates compiled timestamp expressions", () => {
    const validation = checkCelBooleanExpression(
      "payload.appointment.startsAt > now && payload.appointment.startsAt < now + days(3)"
    );

    expect(validation.ok).toBe(true);
  });

  it("evaluates timestamp comparisons", () => {
    const evaluation = evaluateCelBooleanExpression({
      expression:
        "payload.appointment.startsAt > now && payload.appointment.startsAt < now + days(3)",
      context: {
        now: new Date("2026-03-01T00:00:00.000Z"),
        payload: {
          appointment: {
            startsAt: new Date("2026-03-02T12:00:00.000Z"),
          },
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
      expression: 'payload.appointment.startsAt > date("2026-03-01")',
      context: {
        now: new Date("2026-01-01T00:00:00.000Z"),
        payload: {
          appointment: {
            startsAt: new Date("2026-03-10T00:00:00.000Z"),
          },
        },
      },
    });

    expect(evaluation.ok).toBe(true);
    if (evaluation.ok) {
      expect(evaluation.value).toBe(true);
    }
  });

  it("reads fields named after CEL type constants", () => {
    // CEL owns `type`, `string`, `map` and the rest of its type names in the root
    // namespace: bare `type == "sms"` fails to compile, and `dyn(type)` compiles
    // and then answers about the constant rather than the payload.
    const expression = 'payload.type == "sms" && payload.map.string == "ok"';

    expect(checkCelBooleanExpression(expression).ok).toBe(true);

    const evaluation = evaluateCelBooleanExpression({
      expression,
      context: {
        now: new Date("2026-01-01T00:00:00.000Z"),
        payload: { type: "sms", map: { string: "ok" } },
      },
    });

    expect(evaluation.ok).toBe(true);
    if (evaluation.ok) {
      expect(evaluation.value).toBe(true);
    }
  });
});
