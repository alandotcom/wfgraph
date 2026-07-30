import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearExtensions,
  configureExtensions,
} from "#src/backend/lib/extensions/current";
import {
  defineIntegration,
  type IntegrationDefinition,
} from "#src/backend/lib/extensions/define-integration";
import { assembleExtensions } from "#src/backend/lib/extensions/extension-set";
import {
  getActionLabel,
  getStepImporter,
} from "#src/backend/lib/step-registry";
import { defineStep } from "#src/backend/lib/steps/define-step";

const sendSms = defineStep({
  label: "Send SMS",
  description: "Send an SMS via Twilio",
  category: "Twilio",
  input: Schema.Struct({ smsTo: Schema.String }),
  output: Schema.Struct({
    sid: Schema.String.annotate({ description: "Message SID" }),
  }),
  configFields: [
    { key: "smsTo", label: "To", type: "template-input", required: true },
  ],
  handler: Effect.fn(function* () {
    return yield* Effect.succeed({ sid: "SM1" });
  }),
});

const twilio: IntegrationDefinition = defineIntegration({
  type: "twilio",
  label: "Twilio",
  description: "Send SMS messages with Twilio Programmable Messaging",
  credentials: [],
  actions: { "send-sms": sendSms },
});

// Every reader of the surface sits inside an app, and `getExtensions` says so by
// throwing, so each case stands one up. An empty assembly still carries the
// built-in four, which is what the cases below that name no integration read.
beforeEach(() => {
  configureExtensions(assembleExtensions({}));
});

afterEach(() => {
  clearExtensions();
});

describe("getActionLabel", () => {
  // The label a run log gives a node has one source: the assembled catalog, which
  // the built-in four are entries of too. A copy beside the step registration
  // could only disagree with it, and nothing would notice which one a reader got.
  it("reads an action's label from the assembled catalog", () => {
    configureExtensions(assembleExtensions({ integrations: [twilio] }));

    expect(getActionLabel("twilio/send-sms")).toBe("Send SMS");
  });

  it("names the built-in actions the engine dispatches itself", () => {
    expect(getActionLabel("HTTP Request")).toBe("HTTP Request");
    expect(getActionLabel("Wait")).toBe("Wait");
  });

  it("has no label for an action nothing declared", () => {
    expect(getActionLabel("nobody/knows")).toBeUndefined();
  });
});

describe("getStepImporter", () => {
  it("dispatches to the step an integration definition carries", async () => {
    configureExtensions(assembleExtensions({ integrations: [twilio] }));

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

  // The two the engine ships itself are Promise functions behind an import, which
  // is the one arm of the lookup an integration definition does not fill.
  it("dispatches to a built-in step the engine ships", () => {
    expect(getStepImporter("HTTP Request")?.kind).toBe("step");
    expect(getStepImporter("Database Query")?.kind).toBe("step");
  });
});
