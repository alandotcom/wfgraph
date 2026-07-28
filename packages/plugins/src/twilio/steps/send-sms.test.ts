import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendSmsStep } from "./send-sms";

// The step's job is deciding whether and what to send, so the seam under it is
// the Twilio client. What that client puts on the wire is covered separately in
// twilio/client.test.ts, against a stubbed fetch.
//
// vi.hoisted, because vitest lifts vi.mock above every import, and the factories
// below read this object the moment the step module is imported.
const mocks = vi.hoisted(() => {
  const fetchCredentials = vi.fn();
  const createMessage = vi.fn();

  return { fetchCredentials, createMessage };
});

// Both come from one module, so stubbing one means supplying the other.
vi.mock("@rova/core/plugin", () => ({
  fetchCredentials: mocks.fetchCredentials,
  withStepLogging: (_input: unknown, run: () => unknown) => run(),
}));

vi.mock("@/twilio/client", () => ({
  createTwilioMessage: mocks.createMessage,
  describeTwilioFailure: (failure: { message?: string }) =>
    failure.message ?? "twilio failure",
}));

describe("sendSmsStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchCredentials.mockResolvedValue({
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "auth-token",
      TWILIO_FROM_NUMBER: "+15551234567",
    });
    // Answer the way Twilio does, in its own snake_case, so the step's reading
    // of the response is exercised rather than assumed.
    mocks.createMessage.mockImplementation(
      async (
        _credentials: unknown,
        parameters: Record<string, string | undefined>
      ) => ({
        ok: true,
        data: {
          sid: "SM123",
          status: "queued",
          to: parameters.To,
          from: parameters.From ?? null,
          messaging_service_sid: parameters.MessagingServiceSid ?? null,
        },
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
    expect(mocks.createMessage).toHaveBeenCalledWith(
      { accountSid: "AC123", authToken: "auth-token" },
      {
        To: "+15557654321",
        Body: "Hello",
        From: "+15551234567",
        MessagingServiceSid: undefined,
        StatusCallback: undefined,
        MediaUrl: undefined,
      }
    );
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

  // The REST names differ from the SDK's camelCase options, and the response
  // key is snake_case. A typo in either is silent: the parameter is dropped or
  // the field reads as absent.
  it("sends Twilio's own parameter names and reads its own response keys", async () => {
    mocks.fetchCredentials.mockResolvedValue({
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "auth-token",
    });

    const result = await sendSmsStep({
      integrationId: "int_twilio",
      smsTo: "+15550001111",
      smsBody: "Hello",
      smsMessagingServiceSid: "MG999",
      smsStatusCallback: "https://example.com/status",
      smsMediaUrls: "https://example.com/a.png, https://example.com/b.png",
      _context: {
        nodeId: "n1",
        nodeName: "SMS",
        nodeType: "action",
        runMode: "live",
      },
    });

    expect(mocks.createMessage).toHaveBeenCalledWith(
      { accountSid: "AC123", authToken: "auth-token" },
      {
        To: "+15550001111",
        Body: "Hello",
        From: undefined,
        MessagingServiceSid: "MG999",
        StatusCallback: "https://example.com/status",
        MediaUrl: ["https://example.com/a.png", "https://example.com/b.png"],
      }
    );
    expect(result).toEqual({
      success: true,
      data: {
        sid: "SM123",
        status: "queued",
        to: "+15550001111",
        from: undefined,
        messagingServiceSid: "MG999",
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
    expect(mocks.createMessage).toHaveBeenCalledTimes(0);
  });
});
