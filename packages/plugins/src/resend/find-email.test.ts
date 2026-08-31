import { describe, expect, it } from "@effect/vitest";
import { actionData, actionError, runAction } from "@wfgraph/core/testing";
import { Effect } from "effect";
import { afterEach, beforeEach, vi } from "vitest";
import * as resendClient from "#src/resend/client";
import { resend } from "#src/resend/index";

const mocks = vi.hoisted(() => ({ getEmail: vi.fn() }));

const RESEND_CREDENTIALS = {
  RESEND_API_KEY: "re_test_key",
};

const retrievedEmail = {
  id: "email_123",
  message_id: "<message@example.com>",
  from: "Support <support@example.com>",
  to: ["user@example.com"],
  cc: null,
  bcc: [],
  reply_to: null,
  subject: "Order received",
  html: "<strong>Received</strong>",
  text: null,
  created_at: new Date("2026-04-03T22:13:42.674981Z"),
  last_event: "delivered",
  scheduled_at: null,
  tags: [
    { name: "campaign", value: "orders" },
    { name: "order_id", value: "ord_7" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEmail.mockReturnValue(Effect.succeed(retrievedEmail));
  vi.spyOn(resendClient, "getResendEmail").mockImplementation(mocks.getEmail);
  vi.spyOn(resendClient, "describeResendFailure").mockImplementation(
    (error: { message?: string }) => error.message ?? "resend failure"
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the find-email action", () => {
  it.effect(
    "retrieves an email and maps its fields for workflow references",
    () =>
      Effect.gen(function* () {
        const result = actionData(
          yield* runAction(resend, "find-email", {
            input: { emailId: "email_123" },
            credentials: Effect.succeed(RESEND_CREDENTIALS),
          })
        );

        expect(result).toEqual({
          id: "email_123",
          messageId: "<message@example.com>",
          from: "Support <support@example.com>",
          to: ["user@example.com"],
          cc: null,
          bcc: [],
          replyTo: null,
          subject: "Order received",
          html: "<strong>Received</strong>",
          text: null,
          createdAt: "2026-04-03T22:13:42.674Z",
          lastEvent: "delivered",
          scheduledAt: null,
          tags: { campaign: "orders", order_id: "ord_7" },
        });
      })
  );

  it.effect("requires a configured API key", () =>
    Effect.gen(function* () {
      const error = actionError(
        yield* runAction(resend, "find-email", {
          input: { emailId: "email_123" },
          credentials: Effect.succeed({}),
        })
      );

      expect(error.message).toBe(
        "RESEND_API_KEY is not configured. Please add it in Project Integrations."
      );
    })
  );

  it.effect("requires a non-empty resolved email id", () =>
    Effect.gen(function* () {
      const error = actionError(
        yield* runAction(resend, "find-email", {
          input: { emailId: "   " },
          credentials: Effect.succeed(RESEND_CREDENTIALS),
        })
      );

      expect(error.message).toBe("Email ID is required.");
    })
  );

  it.effect("reports Resend's failure in readable form", () =>
    Effect.gen(function* () {
      mocks.getEmail.mockReturnValue(
        Effect.fail({ message: "Email not found" })
      );

      const error = actionError(
        yield* runAction(resend, "find-email", {
          input: { emailId: "missing" },
          credentials: Effect.succeed(RESEND_CREDENTIALS),
        })
      );

      expect(error.message).toBe("Failed to find email: Email not found");
    })
  );
});
