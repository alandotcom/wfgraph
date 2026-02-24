import { beforeEach, describe, expect, it, mock, vi } from "bun:test";

const mocks = (() => {
  const fetchCredentials = vi.fn();
  const resendCtor = vi.fn();
  const sendEmail = vi.fn();

  return {
    fetchCredentials,
    resendCtor,
    sendEmail,
  };
})();

mock.module("@/backend/lib/credential-fetcher", () => ({
  fetchCredentials: mocks.fetchCredentials,
}));

mock.module("resend", () => {
  class Resend {
    emails = {
      send: mocks.sendEmail,
    };

    constructor(apiKey: string) {
      mocks.resendCtor(apiKey);
    }
  }

  return { Resend };
});

const { sendEmailStep } = await import("./send-email");

describe("sendEmailStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchCredentials.mockResolvedValue({
      RESEND_API_KEY: "re_test_key",
      RESEND_FROM_EMAIL: "from@example.com",
    });
    mocks.sendEmail.mockResolvedValue({
      data: { id: "email_123" },
      error: null,
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
    expect(mocks.resendCtor).toHaveBeenCalledWith("re_test_key");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const [payload, options] = mocks.sendEmail.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(payload.to).toBe("qa@example.com");
    expect(payload.cc).toBeUndefined();
    expect(payload.bcc).toBeUndefined();
    expect(options).toEqual({ idempotencyKey: undefined });
    expect(result).toEqual({
      success: true,
      data: { id: "email_123" },
    });
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
