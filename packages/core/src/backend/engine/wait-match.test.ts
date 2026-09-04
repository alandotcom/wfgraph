import { describe, expect, it } from "vitest";
import { serializeConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import { compileWaitSubscriptions } from "#src/backend/engine/wait-match";

describe("compileWaitSubscriptions", () => {
  it("stores no Connection for a subscription whose Connection is blank", () => {
    const result = compileWaitSubscriptions({
      subscriptions: [{ event: "resend/email.delivered", connectionId: "" }],
      resolveTemplates: (value) => value,
    });

    // `connectionMatches` reads a stored blank as a Connection of its own, so a
    // subscription that never picked one would only wake on an arrival with an
    // equally blank Connection, which no arrival carries.
    expect(result).toEqual({
      valid: true,
      subscriptions: [{ event: "resend/email.delivered" }],
    });
    expect(result.valid && "connectionId" in result.subscriptions[0]).toBe(
      false
    );
  });

  it("keeps the Connection a subscription picked", () => {
    const result = compileWaitSubscriptions({
      subscriptions: [
        { event: "resend/email.delivered", connectionId: "int_1" },
      ],
      resolveTemplates: (value) => value,
    });

    expect(result).toEqual({
      valid: true,
      subscriptions: [
        { event: "resend/email.delivered", connectionId: "int_1" },
      ],
    });
  });

  it("resolves an upstream timestamp before compiling a Wait match", () => {
    const token = "{{@entry:Lifecycle.interviewAt}}";
    const result = compileWaitSubscriptions({
      subscriptions: [
        {
          event: "interview.rescheduled",
          match: serializeConditionModel({
            version: 2,
            groupLogic: "and",
            groups: [
              {
                id: "group",
                logic: "and",
                conditions: [
                  {
                    id: "rule",
                    field: "occurredAt",
                    fieldType: "timestamp",
                    operator: "after",
                    dateTime: token,
                  },
                ],
              },
            ],
          }),
        },
      ],
      resolveTemplates: (value) =>
        value === token ? "2030-01-01T09:00:00.000Z" : value,
    });

    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.subscriptions[0]?.match).toEqual({
      expression:
        '((has(payload.occurredAt) && (payload.occurredAt > date("2030-01-01T09:00:00.000Z"))))',
      timestampPaths: ["occurredAt"],
    });
  });
});
