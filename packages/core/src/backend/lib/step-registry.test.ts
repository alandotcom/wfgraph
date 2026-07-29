import { Effect, Schema } from "effect";
import {
  registerIntegration,
  unregisterIntegration,
} from "@rova/shared/plugins/registry";
import { afterEach, describe, expect, it } from "vitest";
import {
  getActionLabel,
  getStepImporter,
  registerStep,
} from "#src/backend/lib/step-registry";
import { defineStep } from "#src/backend/lib/steps/define-step";

const step = defineStep({
  id: "twilio/send-sms",
  input: Schema.Struct({ smsTo: Schema.String }),
  output: Schema.Struct({ sid: Schema.String }),
  handler: Effect.fn(function* () {
    return yield* Effect.succeed({ sid: "SM1" });
  }),
});

afterEach(() => {
  unregisterIntegration("twilio");
});

describe("getActionLabel", () => {
  // The label a run log gives a node has one source: the action metadata the
  // editor renders. A copy beside the step registration could only disagree
  // with it, and nothing would notice which one a reader got.
  it("reads a plugin action's label from the integration metadata", () => {
    registerIntegration({
      type: "twilio",
      label: "Twilio",
      description: "Send SMS messages with Twilio Programmable Messaging",
      formFields: [],
      actions: [
        {
          slug: "send-sms",
          label: "Send SMS",
          description: "Send an SMS via Twilio",
          category: "Twilio",
          configFields: [],
        },
      ],
    });

    expect(getActionLabel("twilio/send-sms")).toBe("Send SMS");
  });

  it("names the built-in actions the engine dispatches itself", () => {
    expect(getActionLabel("HTTP Request")).toBe("HTTP Request");
    expect(getActionLabel("Wait")).toBe("Wait");
  });

  it("has no label for an action nothing registered", () => {
    expect(getActionLabel("nobody/knows")).toBeUndefined();
  });
});

describe("registerStep", () => {
  // The registration used to be a pair of strings: an action id and the name of
  // an export to go looking for. Neither half was checked, so a renamed export
  // became an action reporting itself missing at run time. What is registered
  // now is the step itself, loaded on demand.
  it("dispatches to the step it was given", async () => {
    registerStep("twilio/send-sms", () => Promise.resolve(step));

    const importer = getStepImporter("twilio/send-sms");
    expect(importer?.kind).toBe("step");

    const run = importer?.kind === "step" ? await importer.load() : undefined;
    expect(await run?.({ smsTo: "+15550001111" })).toEqual({
      success: true,
      data: { sid: "SM1" },
    });
  });

  it("has no importer for an action nothing registered", () => {
    expect(getStepImporter("nobody/knows")).toBeUndefined();
  });

  // The guarantee the signature makes is a compile-time one, so the type check
  // is where it is asserted: `@ts-expect-error` fails the build if this call
  // ever stops erroring, which is what would happen if the key and the loader
  // were free to name different actions again.
  it("refuses a step registered under an id it does not answer to", () => {
    // @ts-expect-error the step loaded here declares "twilio/send-sms"
    registerStep("twilio/lookup-number", () => Promise.resolve(step));

    // The call still runs, which is what keeps the directive above attached to
    // a real registration rather than to a line the compiler skipped.
    expect(getStepImporter("twilio/lookup-number")?.kind).toBe("step");
  });
});
