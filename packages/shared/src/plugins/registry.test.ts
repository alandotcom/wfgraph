import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { registerIntegration } from "./registry";

/**
 * `requireOutputFieldsFromSchema` names the offender by a phrase its caller
 * passes, since an Event's payload schema comes through it too. On the action
 * side that phrase has to carry the computed id, which is the only name that
 * tells a plugin author which action to go and fix.
 *
 * The throw lands before the registry is written, so this leaks no
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
