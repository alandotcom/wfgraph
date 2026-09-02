import { describe, expect, it } from "@effect/vitest";
import { actionData, actionError, runAction } from "@wfgraph/core/testing";
import { Effect } from "effect";
import { afterEach, beforeEach, vi } from "vitest";
import * as resendClient from "#src/resend/client";
import { resend } from "#src/resend/index";

const underTest = resend;

// What this step decides is whether and where to send, so the seam under it is
// the Resend client. What that client puts on the wire is covered separately in
// resend/client.test.ts, against a stubbed fetch. Spy rather than `vi.mock` so
// a worker that already evaluated this module still sees the stub.
const mocks = vi.hoisted(() => ({ sendEmail: vi.fn() }));

const RESEND_CREDENTIALS = {
  RESEND_API_KEY: "re_test_key",
  RESEND_FROM_EMAIL: "from@example.com",
};

/**
 * The credentials a run would have fetched, and a count of the times the step
 * asked for them.
 *
 * A step hands its handler the fetch as an effect rather than a value, so a step
 * that decides it has nothing to send never reads the integration's secrets.
 * The count is what pins that.
 */
function credentialsRead(
  values: Record<string, string | undefined> = RESEND_CREDENTIALS
) {
  const reads = { count: 0 };

  return {
    reads,
    credentials: Effect.sync(() => {
      reads.count += 1;
      return values;
    }),
  };
}

/** The arguments the client was called with, as the step passed them. */
function sentCall() {
  return mocks.sendEmail.mock.calls[0] as [
    string,
    Record<string, unknown>,
    string | undefined,
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendEmail.mockReturnValue(Effect.succeed({ id: "email_123" }));
  vi.spyOn(resendClient, "sendResendEmail").mockImplementation(mocks.sendEmail);
  vi.spyOn(resendClient, "describeResendFailure").mockImplementation(
    (error: { message?: string }) => error.message ?? "resend failure"
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the send-email action", () => {
  it.effect("logs only in test mode by default and skips external calls", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(underTest, "send-email", {
          input: {
            emailTo: "user@example.com",
            emailSubject: "Subject",
            emailBody: "Body",
          },
          credentials,
          runMode: "test",
        })
      );

      expect(result).toEqual({
        id: "resend:test-log-only:no_execution",
        reasonCode: "test_mode_log_only",
      });
      expect(reads.count).toBe(0);
      expect(mocks.sendEmail).toHaveBeenCalledTimes(0);
    })
  );

  it.effect("routes to test recipient in test mode and strips cc/bcc", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(underTest, "send-email", {
          input: {
            emailTo: "real-user@example.com",
            emailCc: "cc@example.com",
            emailBcc: "bcc@example.com",
            emailSubject: "Subject",
            emailBody: "Body",
            testBehavior: "send_to_test_email",
            testEmailTo: "  qa@example.com  ",
          },
          credentials,
          runMode: "test",
        })
      );

      expect(reads.count).toBe(1);
      const [apiKey, payload, idempotencyKey] = sentCall();
      expect(apiKey).toBe("re_test_key");
      expect(payload.to).toBe("qa@example.com");
      expect(payload.cc).toBeUndefined();
      expect(payload.bcc).toBeUndefined();
      expect(idempotencyKey).toBeUndefined();
      expect(result).toEqual({ id: "email_123" });
    })
  );

  // Resend's body is snake_case where the SDK took camelCase. Getting a name
  // wrong drops that field silently: the email sends with no reply-to, no
  // schedule, no topic, and nothing reports a problem.
  it.effect("sends Resend's own snake_case field names", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      yield* runAction(underTest, "send-email", {
        input: {
          emailTo: "user@example.com",
          emailSubject: "Subject",
          emailBody: "Body",
          emailCc: "cc@example.com",
          emailBcc: "bcc@example.com",
          emailReplyTo: "reply@example.com",
          emailScheduledAt: "2026-08-01T00:00:00Z",
          emailTopicId: "topic_1",
          emailTags: JSON.stringify([{ name: "campaign", value: "spring" }]),
        },
        credentials,
      });

      const [, payload] = sentCall();

      expect(payload).toEqual({
        from: "from@example.com",
        to: "user@example.com",
        subject: "Subject",
        text: "Body",
        cc: "cc@example.com",
        bcc: "bcc@example.com",
        reply_to: "reply@example.com",
        scheduled_at: "2026-08-01T00:00:00Z",
        topic_id: "topic_1",
        tags: [{ name: "campaign", value: "spring" }],
      });
    })
  );

  // Resend takes a list on the way out and answers a record on its webhooks. The
  // step reports the record, so `tags.campaign` names the same thing on this
  // node's output as on a `resend/email.delivered` payload.
  it.effect("answers the tags it sent, keyed by name", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(underTest, "send-email", {
          input: {
            emailTo: "user@example.com",
            emailSubject: "Subject",
            emailBody: "Body",
            emailTags: JSON.stringify([
              { name: "campaign", value: "spring" },
              { name: "order_id", value: "ord_7" },
            ]),
          },
          credentials,
        })
      );

      expect(result).toEqual({
        id: "email_123",
        tags: { campaign: "spring", order_id: "ord_7" },
      });
    })
  );

  // A test run is where somebody checks what their references resolved to, and
  // it spends no send, so the tags have to come back without one.
  it.effect("answers the tags a test run would have sent", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(underTest, "send-email", {
          input: {
            emailTo: "user@example.com",
            emailSubject: "Subject",
            emailBody: "Body",
            emailTags: JSON.stringify([{ name: "order_id", value: "ord_7" }]),
          },
          credentials,
          runMode: "test",
        })
      );

      expect(result).toEqual({
        id: "resend:test-log-only:no_execution",
        reasonCode: "test_mode_log_only",
        tags: { order_id: "ord_7" },
      });
      expect(mocks.sendEmail).toHaveBeenCalledTimes(0);
    })
  );

  it.effect("leaves the key off a send that carried no tags", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(underTest, "send-email", {
          input: {
            emailTo: "user@example.com",
            emailSubject: "Subject",
            emailBody: "Body",
            emailTags: "[]",
          },
          credentials,
        })
      );

      // The output crosses the canonical JSON codec, where a key declared
      // `optional` and holding undefined encodes as `tags: null`. A send that
      // carried no tags answers with no `tags` key at all.
      expect(result).toEqual({ id: "email_123" });
      expect(Object.keys(result as object)).toEqual(["id"]);
    })
  );

  // The run's id is the idempotency key, which is what keeps an Inngest retry
  // from sending a second copy of the same email.
  it.effect("sends the execution id as the idempotency key", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      yield* runAction(underTest, "send-email", {
        input: {
          emailTo: "user@example.com",
          emailSubject: "Subject",
          emailBody: "Body",
        },
        credentials,
        node: { executionId: "exec_42" },
      });

      const [, , idempotencyKey] = sentCall();
      expect(idempotencyKey).toBe("exec_42");
    })
  );

  it.effect("sends a template as Resend's template object", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      yield* runAction(underTest, "send-email", {
        input: {
          emailTo: "user@example.com",
          emailSubject: "Subject",
          emailContentMode: "template",
          emailTemplateId: "tmpl_1",
          emailTemplateVariables: JSON.stringify({ name: "Ada" }),
        },
        credentials,
      });

      const [, payload] = sentCall();

      expect(payload.template).toEqual({
        id: "tmpl_1",
        variables: { name: "Ada" },
      });
      // A template request must carry no html/text/react, which Resend rejects.
      expect(payload.html).toBeUndefined();
      expect(payload.text).toBeUndefined();
    })
  );

  it.effect("falls back to log-only when test recipient is invalid", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = actionData(
        yield* runAction(underTest, "send-email", {
          input: {
            emailTo: "real-user@example.com",
            emailSubject: "Subject",
            emailBody: "Body",
            testBehavior: "send_to_test_email",
            testEmailTo: "not-an-email",
          },
          credentials,
          runMode: "test",
        })
      );

      expect(result).toEqual({
        id: "resend:test-log-fallback:no_execution",
        reasonCode: "test_mode_log_fallback_invalid_test_email",
      });
      expect(reads.count).toBe(0);
      expect(mocks.sendEmail).toHaveBeenCalledTimes(0);
    })
  );

  it.effect("names the content mode's missing field", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(underTest, "send-email", {
          input: {
            emailTo: "user@example.com",
            emailSubject: "Subject",
            emailContentMode: "html",
          },
          credentials,
        })
      );

      expect(error.message).toBe(
        "Content Mode is HTML, so HTML Body must be filled in."
      );
      expect(mocks.sendEmail).toHaveBeenCalledTimes(0);
    })
  );

  // Tags are an output other nodes reference by key, so a box that does not parse
  // has to stop the run. Sending an untagged email and reporting success leaves
  // every downstream `tags.order_id` reading nothing, with no sign of why.
  it.effect("fails on a tags box that is not valid JSON", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(underTest, "send-email", {
          input: {
            emailTo: "user@example.com",
            emailSubject: "Subject",
            emailBody: "Body",
            emailTags: "{not json",
          },
          credentials,
        })
      );

      expect(error.message).toBe("Tags is not valid JSON.");
      expect(mocks.sendEmail).toHaveBeenCalledTimes(0);
    })
  );

  it.effect("fails on tags JSON that is not name and value rows", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(underTest, "send-email", {
          input: {
            emailTo: "user@example.com",
            emailSubject: "Subject",
            emailBody: "Body",
            emailTags: JSON.stringify({ campaign: "spring" }),
          },
          credentials,
        })
      );

      expect(error.message).toBe(
        "Tags must be a list of name and value entries."
      );
      expect(mocks.sendEmail).toHaveBeenCalledTimes(0);
    })
  );

  it.effect("says which credential is missing before reaching Resend", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead({});

      const error = actionError(
        yield* runAction(underTest, "send-email", {
          input: {
            emailTo: "user@example.com",
            emailSubject: "Subject",
            emailBody: "Body",
          },
          credentials,
        })
      );

      expect(error.message).toBe(
        "RESEND_API_KEY is not configured. Please add it in Project Integrations."
      );
      expect(mocks.sendEmail).toHaveBeenCalledTimes(0);
    })
  );

  it.effect("fails with the message the system's refusal carries", () =>
    Effect.gen(function* () {
      mocks.sendEmail.mockReturnValue(
        Effect.fail({ message: "The `to` field is required." })
      );
      const { credentials } = credentialsRead();

      const error = actionError(
        yield* runAction(underTest, "send-email", {
          input: {
            emailTo: "user@example.com",
            emailSubject: "Subject",
            emailBody: "Body",
          },
          credentials,
        })
      );

      expect(error.message).toBe(
        "Failed to send email: The `to` field is required."
      );
    })
  );
});
