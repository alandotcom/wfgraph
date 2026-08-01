import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { beforeEach, vi } from "vitest";
import { sendEmailHandler } from "#src/resend/index";

// What this step decides is whether and where to send, so the seam under it is
// the Resend client. What that client puts on the wire is covered separately in
// resend/client.test.ts, against a stubbed fetch.
const mocks = vi.hoisted(() => ({ sendEmail: vi.fn() }));

vi.mock("#src/resend/client", () => ({
  sendResendEmail: mocks.sendEmail,
  describeResendFailure: (error: { message?: string }) =>
    error.message ?? "resend failure",
}));

const RESEND_CREDENTIALS = {
  RESEND_API_KEY: "re_test_key",
  RESEND_FROM_EMAIL: "from@example.com",
};

/**
 * The credentials a run would have fetched, and a count of the times the step
 * asked for them.
 *
 * `defineStep` hands the fetch over as an effect rather than a value, so a step
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

function bagFor<TInput>(
  input: TInput,
  runMode: "live" | "test",
  credentials: Effect.Effect<Record<string, string | undefined>>,
  executionId?: string
) {
  return {
    input,
    runMode,
    executionId,
    nodeId: "n1",
    nodeName: "Email",
    nodeType: "action",
    integrationId: "int_resend",
    credentials,
    readCredentials: () => Effect.runPromise(credentials),
  };
}

/** A step that succeeds fails the flip, which is what makes the test say so. */
const failure = Effect.flip;

// Nothing here reaches the network, because the client is stubbed above. The
// transport is provided all the same, since that is what a handler declares it
// needs and the compiler holds the test to it.
const withTransport = Effect.provide(FetchHttpClient.layer);

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
});

describe("sendEmailHandler", () => {
  it.effect("logs only in test mode by default and skips external calls", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = yield* sendEmailHandler(
        bagFor(
          {
            emailTo: "user@example.com",
            emailSubject: "Subject",
            emailBody: "Body",
          },
          "test",
          credentials
        )
      );

      expect(result).toEqual({
        id: "resend:test-log-only:no_execution",
        reasonCode: "test_mode_log_only",
      });
      expect(reads.count).toBe(0);
      expect(mocks.sendEmail).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect("routes to test recipient in test mode and strips cc/bcc", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = yield* sendEmailHandler(
        bagFor(
          {
            emailTo: "real-user@example.com",
            emailCc: "cc@example.com",
            emailBcc: "bcc@example.com",
            emailSubject: "Subject",
            emailBody: "Body",
            testBehavior: "send_to_test_email",
            testEmailTo: "  qa@example.com  ",
          },
          "test",
          credentials
        )
      );

      expect(reads.count).toBe(1);
      const [apiKey, payload, idempotencyKey] = sentCall();
      expect(apiKey).toBe("re_test_key");
      expect(payload.to).toBe("qa@example.com");
      expect(payload.cc).toBeUndefined();
      expect(payload.bcc).toBeUndefined();
      expect(idempotencyKey).toBeUndefined();
      expect(result).toEqual({ id: "email_123" });
    }).pipe(withTransport)
  );

  // Resend's body is snake_case where the SDK took camelCase. Getting a name
  // wrong drops that field silently: the email sends with no reply-to, no
  // schedule, no topic, and nothing reports a problem.
  it.effect("sends Resend's own snake_case field names", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      yield* sendEmailHandler(
        bagFor(
          {
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
          "live",
          credentials
        )
      );

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
    }).pipe(withTransport)
  );

  // The run's id is the idempotency key, which is what keeps an Inngest retry
  // from sending a second copy of the same email.
  it.effect("sends the execution id as the idempotency key", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      yield* sendEmailHandler(
        bagFor(
          {
            emailTo: "user@example.com",
            emailSubject: "Subject",
            emailBody: "Body",
          },
          "live",
          credentials,
          "exec_42"
        )
      );

      const [, , idempotencyKey] = sentCall();
      expect(idempotencyKey).toBe("exec_42");
    }).pipe(withTransport)
  );

  it.effect("sends a template as Resend's template object", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      yield* sendEmailHandler(
        bagFor(
          {
            emailTo: "user@example.com",
            emailSubject: "Subject",
            emailContentMode: "template",
            emailTemplateId: "tmpl_1",
            emailTemplateVariables: JSON.stringify({ name: "Ada" }),
          },
          "live",
          credentials
        )
      );

      const [, payload] = sentCall();

      expect(payload.template).toEqual({
        id: "tmpl_1",
        variables: { name: "Ada" },
      });
      // A template request must carry no html/text/react, which Resend rejects.
      expect(payload.html).toBeUndefined();
      expect(payload.text).toBeUndefined();
    }).pipe(withTransport)
  );

  it.effect("falls back to log-only when test recipient is invalid", () =>
    Effect.gen(function* () {
      const { reads, credentials } = credentialsRead();

      const result = yield* sendEmailHandler(
        bagFor(
          {
            emailTo: "real-user@example.com",
            emailSubject: "Subject",
            emailBody: "Body",
            testBehavior: "send_to_test_email",
            testEmailTo: "not-an-email",
          },
          "test",
          credentials
        )
      );

      expect(result).toEqual({
        id: "resend:test-log-fallback:no_execution",
        reasonCode: "test_mode_log_fallback_invalid_test_email",
      });
      expect(reads.count).toBe(0);
      expect(mocks.sendEmail).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect("names the content mode's missing field", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead();

      const error = yield* failure(
        sendEmailHandler(
          bagFor(
            {
              emailTo: "user@example.com",
              emailSubject: "Subject",
              emailContentMode: "html",
            },
            "live",
            credentials
          )
        )
      );

      expect(error.message).toBe("HTML mode requires emailHtml.");
      expect(mocks.sendEmail).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect("says which credential is missing before reaching Resend", () =>
    Effect.gen(function* () {
      const { credentials } = credentialsRead({});

      const error = yield* failure(
        sendEmailHandler(
          bagFor(
            {
              emailTo: "user@example.com",
              emailSubject: "Subject",
              emailBody: "Body",
            },
            "live",
            credentials
          )
        )
      );

      expect(error.message).toBe(
        "RESEND_API_KEY is not configured. Please add it in Project Integrations."
      );
      expect(mocks.sendEmail).toHaveBeenCalledTimes(0);
    }).pipe(withTransport)
  );

  it.effect("fails with the message the system's refusal carries", () =>
    Effect.gen(function* () {
      mocks.sendEmail.mockReturnValue(
        Effect.fail({ message: "The `to` field is required." })
      );
      const { credentials } = credentialsRead();

      const error = yield* failure(
        sendEmailHandler(
          bagFor(
            {
              emailTo: "user@example.com",
              emailSubject: "Subject",
              emailBody: "Body",
            },
            "live",
            credentials
          )
        )
      );

      expect(error.message).toBe(
        "Failed to send email: The `to` field is required."
      );
    }).pipe(withTransport)
  );
});
