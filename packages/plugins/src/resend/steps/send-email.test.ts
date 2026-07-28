import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmailStep } from "./send-email";

// The step's job is deciding whether and what to send, so the seam under it is
// the Resend client. What that client puts on the wire is covered separately in
// resend/client.test.ts, against a stubbed fetch.
const mocks = vi.hoisted(() => {
  const fetchCredentials = vi.fn();
  const sendEmail = vi.fn();

  return { fetchCredentials, sendEmail };
});

// Both come from one module, so stubbing one means supplying the other.
vi.mock("@rova/core/plugin", () => ({
  fetchCredentials: mocks.fetchCredentials,
  withStepLogging: (_input: unknown, run: () => unknown) => run(),
}));

vi.mock("@/resend/client", () => ({
  sendResendEmail: mocks.sendEmail,
  describeResendFailure: (failure: { message?: string }) =>
    failure.message ?? "resend failure",
}));

describe("sendEmailStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchCredentials.mockResolvedValue({
      RESEND_API_KEY: "re_test_key",
      RESEND_FROM_EMAIL: "from@example.com",
    });
    mocks.sendEmail.mockResolvedValue({
      ok: true,
      data: { id: "email_123" },
    });
  });

  it("logs only in test mode by default and skips external calls", async () => {
    const result = await sendEmailStep({
      integrationId: "int_resend",
      emailTo: "user@example.com",
      emailSubject: "Subject",
      emailBody: "Body",
      _context: {
        nodeId: "n1",
        nodeName: "Email",
        nodeType: "action",
        runMode: "test",
      },
    });

    expect(result).toEqual({
      success: true,
      data: {
        id: "resend:test-log-only:no_execution",
        reasonCode: "test_mode_log_only",
      },
    });
    expect(mocks.fetchCredentials).toHaveBeenCalledTimes(0);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(0);
  });

  it("routes to test recipient in test mode and strips cc/bcc", async () => {
    const result = await sendEmailStep({
      integrationId: "int_resend",
      emailTo: "real-user@example.com",
      emailCc: "cc@example.com",
      emailBcc: "bcc@example.com",
      emailSubject: "Subject",
      emailBody: "Body",
      testBehavior: "send_to_test_email",
      testEmailTo: "  qa@example.com  ",
      _context: {
        nodeId: "n1",
        nodeName: "Email",
        nodeType: "action",
        runMode: "test",
      },
    });

    expect(mocks.fetchCredentials).toHaveBeenCalledWith("int_resend");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const [apiKey, payload, idempotencyKey] = mocks.sendEmail.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string | undefined,
    ];
    expect(apiKey).toBe("re_test_key");
    expect(payload.to).toBe("qa@example.com");
    expect(payload.cc).toBeUndefined();
    expect(payload.bcc).toBeUndefined();
    expect(idempotencyKey).toBeUndefined();
    expect(result).toEqual({
      success: true,
      data: { id: "email_123" },
    });
  });

  // Resend's body is snake_case where the SDK took camelCase. Getting a name
  // wrong drops that field silently: the email sends with no reply-to, no
  // schedule, no topic, and nothing reports a problem.
  it("sends Resend's own snake_case field names", async () => {
    await sendEmailStep({
      integrationId: "int_resend",
      emailTo: "user@example.com",
      emailSubject: "Subject",
      emailBody: "Body",
      emailCc: "cc@example.com",
      emailBcc: "bcc@example.com",
      emailReplyTo: "reply@example.com",
      emailScheduledAt: "2026-08-01T00:00:00Z",
      emailTopicId: "topic_1",
      emailTags: JSON.stringify([{ name: "campaign", value: "spring" }]),
      _context: {
        nodeId: "n1",
        nodeName: "Email",
        nodeType: "action",
        runMode: "live",
      },
    });

    const [, payload] = mocks.sendEmail.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];

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
  });

  it("sends a template as Resend's template object", async () => {
    await sendEmailStep({
      integrationId: "int_resend",
      emailTo: "user@example.com",
      emailSubject: "Subject",
      emailContentMode: "template",
      emailTemplateId: "tmpl_1",
      emailTemplateVariables: JSON.stringify({ name: "Ada" }),
      _context: {
        nodeId: "n1",
        nodeName: "Email",
        nodeType: "action",
        runMode: "live",
      },
    });

    const [, payload] = mocks.sendEmail.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];

    expect(payload.template).toEqual({
      id: "tmpl_1",
      variables: { name: "Ada" },
    });
    // A template request must carry no html/text/react, which Resend rejects.
    expect(payload.html).toBeUndefined();
    expect(payload.text).toBeUndefined();
  });

  it("falls back to log-only when test recipient is invalid", async () => {
    const result = await sendEmailStep({
      integrationId: "int_resend",
      emailTo: "real-user@example.com",
      emailSubject: "Subject",
      emailBody: "Body",
      testBehavior: "send_to_test_email",
      testEmailTo: "not-an-email",
      _context: {
        nodeId: "n1",
        nodeName: "Email",
        nodeType: "action",
        runMode: "test",
      },
    });

    expect(result).toEqual({
      success: true,
      data: {
        id: "resend:test-log-fallback:no_execution",
        reasonCode: "test_mode_log_fallback_invalid_test_email",
      },
    });
    expect(mocks.fetchCredentials).toHaveBeenCalledTimes(0);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(0);
  });
});
