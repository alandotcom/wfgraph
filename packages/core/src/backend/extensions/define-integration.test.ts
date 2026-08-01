import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type CredentialsOf,
  defineIntegration,
} from "#src/backend/extensions/define-integration";
import type { CredentialFields } from "@rova/shared/extensions/catalog";
import { defineStep } from "#src/backend/extensions/steps/define-step";

const twilioCredentialFields = {
  TWILIO_ACCOUNT_SID: { label: "Account SID", type: "text" },
  TWILIO_AUTH_TOKEN: { label: "Auth Token", type: "password" },
} satisfies CredentialFields;

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
      credentials: {},
      actions: { "send-sms": sendSms },
    });

    expect(twilio.actions["send-sms"]).not.toHaveProperty("id");
  });
});

describe("CredentialsOf", () => {
  // A record literal's keys are literal types already, which is why declaring
  // credentials this way needs no helper to preserve them.
  it("names the keys the credential record declared", () => {
    expectTypeOf<CredentialsOf<typeof twilioCredentialFields>>().toEqualTypeOf<{
      TWILIO_ACCOUNT_SID?: string;
      TWILIO_AUTH_TOKEN?: string;
    }>();
  });

  it("describes no key for an integration declaring no credentials", () => {
    expectTypeOf<CredentialsOf<Record<never, never>>>().toEqualTypeOf<
      Record<never, string>
    >();
  });
});
