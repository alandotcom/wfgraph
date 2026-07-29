import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { sendSmsInput } from "#src/twilio/schemas";

const decode = Schema.decodeUnknownResult(sendSmsInput, { errors: "all" });

describe("sendSmsInput", () => {
  // What a real run hands a step. The engine resolves a node's templates into
  // every config key the action declares, so a field the user left blank
  // arrives as a key holding `undefined` rather than as no key at all --
  // `Schema.optionalKey` would refuse it, and the step would fail before it
  // read anything.
  it("takes the config a run builds, blank fields included", () => {
    const decoded = decode({
      smsTo: "+15550001111",
      smsBody: "Hello",
      smsFrom: undefined,
      smsMessagingServiceSid: undefined,
      smsStatusCallback: undefined,
      smsMediaUrls: undefined,
      testBehavior: "log_only",
      testPhoneTo: undefined,
    });

    expect(Result.isSuccess(decoded)).toBe(true);
  });

  // The step's input names the fields the step reads, and the engine's record
  // carries more than that: the action id, the integration reference, and the
  // logging context ride along in the same object.
  it("ignores the fields the engine adds around the config", () => {
    const decoded = decode({
      smsTo: "+15550001111",
      smsBody: "Hello",
      actionType: "twilio/send-sms",
      integrationId: "int_twilio",
      _context: { nodeId: "n1", nodeName: "SMS", nodeType: "action" },
    });

    expect(Result.isSuccess(decoded) && decoded.success).toEqual({
      smsTo: "+15550001111",
      smsBody: "Hello",
    });
  });
});
