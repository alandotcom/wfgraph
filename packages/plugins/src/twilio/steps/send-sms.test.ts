import { beforeEach, describe, expect, it, mock, vi } from "bun:test";

const mocks = (() => {
  const fetchCredentials = vi.fn();
  const twilioFactory = vi.fn();
  const createMessage = vi.fn();

  return {
    fetchCredentials,
    twilioFactory,
    createMessage,
  };
})();

mock.module("@/backend/lib/credential-fetcher", () => ({
  fetchCredentials: mocks.fetchCredentials,
}));

mock.module("twilio", () => {
  class RestException extends Error {
    status: number;

    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  }

  const factory = ((...args: unknown[]) => mocks.twilioFactory(...args)) as ((
    ...args: unknown[]
  ) => unknown) & { RestException?: typeof RestException };
  factory.RestException = RestException;

  return { default: factory };
});

const { sendSmsStep } = await import("./send-sms");

describe("sendSmsStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchCredentials.mockResolvedValue({
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "auth-token",
      TWILIO_FROM_NUMBER: "+15551234567",
    });
    mocks.twilioFactory.mockReturnValue({
      messages: { create: mocks.createMessage },
    });
    mocks.createMessage.mockImplementation(
      async (payload: { to: string; from?: string }) => ({
        sid: "SM123",
        status: "queued",
        to: payload.to,
        from: payload.from ?? null,
        messagingServiceSid: null,
      })
    );
  });

  it("logs only in test mode by default and skips external calls", async () => {
    const result = await sendSmsStep({
      integrationId: "int_twilio",
      smsTo: "+15550001111",
      smsBody: "Hello",
      _context: {
        nodeId: "n1",
        nodeName: "SMS",
        nodeType: "action",
        runMode: "test",
      },
    });

    expect(result).toEqual({
      success: true,
      data: {
        sid: "twilio:test-log-only:no_execution",
        status: "queued",
        to: "+15550001111",
        reasonCode: "test_mode_log_only",
      },
    });
    expect(mocks.fetchCredentials).toHaveBeenCalledTimes(0);
    expect(mocks.twilioFactory).toHaveBeenCalledTimes(0);
    expect(mocks.createMessage).toHaveBeenCalledTimes(0);
  });

  it("routes to configured test phone in test mode", async () => {
    const result = await sendSmsStep({
      integrationId: "int_twilio",
      smsTo: "+15550001111",
      smsBody: "Hello",
      testBehavior: "send_to_test_phone",
      testPhoneTo: "  +15557654321 ",
      _context: {
        nodeId: "n1",
        nodeName: "SMS",
        nodeType: "action",
        runMode: "test",
      },
    });

    expect(mocks.fetchCredentials).toHaveBeenCalledWith("int_twilio");
    expect(mocks.twilioFactory).toHaveBeenCalledWith("AC123", "auth-token");
    expect(mocks.createMessage).toHaveBeenCalledWith({
      body: "Hello",
      from: "+15551234567",
      to: "+15557654321",
    });
    expect(result).toEqual({
      success: true,
      data: {
        sid: "SM123",
        status: "queued",
        to: "+15557654321",
        from: "+15551234567",
        messagingServiceSid: undefined,
      },
    });
  });

  it("falls back to log-only when test phone is invalid", async () => {
    const result = await sendSmsStep({
      integrationId: "int_twilio",
      smsTo: "+15550001111",
      smsBody: "Hello",
      testBehavior: "send_to_test_phone",
      testPhoneTo: "not-a-phone",
      _context: {
        nodeId: "n1",
        nodeName: "SMS",
        nodeType: "action",
        runMode: "test",
      },
    });

    expect(result).toEqual({
      success: true,
      data: {
        sid: "twilio:test-log-fallback:no_execution",
        status: "queued",
        to: "+15550001111",
        reasonCode: "test_mode_log_fallback_invalid_test_phone",
      },
    });
    expect(mocks.fetchCredentials).toHaveBeenCalledTimes(0);
    expect(mocks.twilioFactory).toHaveBeenCalledTimes(0);
    expect(mocks.createMessage).toHaveBeenCalledTimes(0);
  });
});
