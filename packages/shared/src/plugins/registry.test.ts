import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { registerIntegration } from "./registry";

/**
 * `requireOutputFieldsFromSchema` names the offender by a phrase its caller
 * passes, because an Event's payload schema comes through it too. This is the
 * action side of that: the phrase has to carry the computed action id, which is
 * the only name that tells a plugin author which of their actions to go and fix.
 *
 * The throw happens before the registry is written, so nothing here leaks a
 * half-registered integration into the files that run after it.
 */
describe("registerIntegration", () => {
  it("names the action whose output schema it cannot read", () => {
    expect(() =>
      registerIntegration({
        type: "twilio",
        label: "Twilio",
        description: "Send SMS messages with Twilio",
        formFields: [],
        actions: [
          {
            slug: "send-sms",
            label: "Send SMS",
            description: "Send an SMS via Twilio",
            category: "Twilio",
            configFields: [],
            // No description annotation, so the editor would offer a path with
            // the word "string" beside it.
            output: Schema.Struct({ sid: Schema.String }),
          },
        ],
      })
    ).toThrow(
      'Action "twilio/send-sms" cannot derive the fields the editor offers'
    );
  });
});
