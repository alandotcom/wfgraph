import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  credentialFields,
  type CredentialsOf,
  defineIntegration,
} from "#src/backend/lib/extensions/define-integration";
import { defineStep } from "#src/backend/lib/steps/define-step";

const twilioCredentialFields = credentialFields([
  {
    label: "Account SID",
    type: "text",
    configKey: "accountSid",
    envVar: "TWILIO_ACCOUNT_SID",
  },
  {
    label: "Auth Token",
    type: "password",
    configKey: "authToken",
    envVar: "TWILIO_AUTH_TOKEN",
  },
]);

const sendSms = defineStep({
  label: "Send SMS",
  description: "Sends a message",
  category: "Twilio",
  input: Schema.Struct({ to: Schema.String }),
  output: Schema.Struct({
    sid: Schema.String.annotate({ description: "Message SID" }),
  }),
  configFields: [{ key: "to", label: "To", type: "template-input" }],
  handler: Effect.fn(function* () {
    return yield* Effect.succeed({ sid: "SM1" });
  }),
});

describe("defineIntegration", () => {
  // Nothing registers on import: the value is the whole of what an integration
  // is, and the line that passes it to `createRovaApp` is what turns it on.
  it("answers a value carrying the credentials and the actions it was given", () => {
    const twilio = defineIntegration({
      type: "twilio",
      label: "Twilio",
      description: "Send SMS messages",
      credentials: twilioCredentialFields,
      actions: { "send-sms": sendSms },
    });

    expect(twilio.kind).toBe("integration");
    expect(twilio.type).toBe("twilio");
    expect(twilio.credentials).toEqual(twilioCredentialFields);
    expect(Object.keys(twilio.actions)).toEqual(["send-sms"]);
    expect(twilio.actions["send-sms"].label).toBe("Send SMS");
  });

  // The slug lives in the record key alone. Nothing here computes the action id,
  // because assembly is where the type and the key are both in hand.
  it("holds no action id of its own", () => {
    const twilio = defineIntegration({
      type: "twilio",
      label: "Twilio",
      description: "Send SMS messages",
      credentials: [],
      actions: { "send-sms": sendSms },
    });

    expect(twilio.actions["send-sms"]).not.toHaveProperty("id");
  });
});

describe("credentialFields", () => {
  // The point of the helper: without the `const` type parameter every `envVar`
  // widens to `string`, and the vocabulary below would describe an open record a
  // handler could misspell a key of.
  it("keeps each envVar a literal type, so CredentialsOf names them", () => {
    expectTypeOf<CredentialsOf<typeof twilioCredentialFields>>().toEqualTypeOf<{
      TWILIO_ACCOUNT_SID?: string;
      TWILIO_AUTH_TOKEN?: string;
    }>();
  });

  it("answers the fields it was handed", () => {
    expect(credentialFields([])).toEqual([]);
  });
});
