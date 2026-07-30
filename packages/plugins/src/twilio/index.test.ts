import { requireOutputFieldsFromSchema } from "@rova/shared/workflow/output-fields";
import { describe, expect, it } from "vitest";
import { twilio } from "#src/twilio/index";

const sendSms = twilio.actions["send-sms"];

describe("the twilio integration", () => {
  // Nothing registers on import. The value is the whole of what an integration
  // is, and the line that passes it to `createRovaApp` is what turns it on.
  it("declares its credentials and its actions as one value", () => {
    expect(twilio.type).toBe("twilio");
    expect(twilio.label).toBe("Twilio");
    expect(twilio.test).toBeDefined();
    expect(twilio.credentials.map((field) => field.envVar)).toEqual([
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_FROM_NUMBER",
      "TWILIO_MESSAGING_SERVICE_SID",
    ]);
    // The slug is the record key and nowhere else, so the id "twilio/send-sms"
    // is computed at assembly rather than written here.
    expect(Object.keys(twilio.actions)).toEqual(["send-sms"]);
    expect(sendSms.label).toBe("Send SMS");
    expect(sendSms.category).toBe("Twilio");
  });

  /**
   * What a node downstream of a Send SMS node can reference.
   *
   * These paths used to be a list written out beside the action, with nothing
   * tying them to what the step returns. They are read off the step's output
   * schema now, which is the same schema the handler is typed against, so this
   * case is where the derivation is pinned: the three paths the hand-written list
   * carried keep their exact descriptions, and the three the step has always
   * returned and never offered are here too.
   *
   * Those three are `nullable`, which is what the schema says about a field the
   * handler may answer with nothing. The condition builder reads it and offers
   * the null checks, which is the right question to ask about a `from` number a
   * Messaging Service send never had.
   */
  it("offers every field the step returns, described by the schema", () => {
    expect(
      requireOutputFieldsFromSchema('Action "twilio/send-sms"', sendSms.output)
    ).toEqual([
      { path: "sid", description: "Message SID", type: "string" },
      { path: "status", description: "Delivery status", type: "string" },
      { path: "to", description: "Recipient phone number", type: "string" },
      {
        path: "from",
        description: "Sender phone number",
        type: "string",
        nullable: true,
      },
      {
        path: "messagingServiceSid",
        description: "Messaging Service SID",
        type: "string",
        nullable: true,
      },
      {
        path: "reasonCode",
        description: "Why a test run did not send",
        type: "string",
        nullable: true,
      },
    ]);
  });

  // Every required key of the config has a field a builder can fill in, which is
  // what assembly holds an action to. The compiler holds the other direction:
  // a field naming a key the input schema does not declare fails to compile.
  it("declares a config field for each key its step insists on", () => {
    const keys = sendSms.configFields.flatMap((field) =>
      "fields" in field ? field.fields.map((one) => one.key) : [field.key]
    );

    expect(keys).toEqual([
      "smsTo",
      "testBehavior",
      "testPhoneTo",
      "smsBody",
      "smsFrom",
      "smsMessagingServiceSid",
      "smsStatusCallback",
      "smsMediaUrls",
    ]);
  });
});
