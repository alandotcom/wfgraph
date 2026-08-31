import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { defineEvent } from "#src/backend/extensions/define-event";
import {
  checkIntegration,
  type CredentialsOf,
  defineIntegration,
} from "#src/backend/extensions/define-integration";
import type { CredentialFields } from "@wfgraph/shared/extensions/catalog";

const twilioCredentialFields = {
  TWILIO_ACCOUNT_SID: { label: "Account SID", type: "text" },
  TWILIO_AUTH_TOKEN: { label: "Auth Token", type: "password" },
} satisfies CredentialFields;

/**
 * The whole definition, written the way an author writes one.
 *
 * The action stays inline. A hoisted action literal has no contextual type, so
 * its `configFields` widen and it stops fitting the slot it was written for,
 * which is the same reason a handler is written inline.
 */
function aTwilio(overrides: { category?: string } = {}) {
  return defineIntegration({
    type: "twilio",
    label: "Twilio",
    description: "Send SMS messages",
    credentials: twilioCredentialFields,
    actions: {
      "send-sms": {
        label: "Send SMS",
        description: "Sends a message",
        category: overrides.category,
        input: Schema.Struct({ to: Schema.String }),
        output: Schema.Struct({
          sid: Schema.String.annotate({ description: "Message SID" }),
        }),
        configFields: [{ key: "to", label: "To", type: "template-input" }],
        handler: Effect.fn(function* () {
          return yield* Effect.succeed({ sid: "SM1" });
        }),
      },
    },
  });
}

describe("defineIntegration", () => {
  // Nothing registers on import: the value is the whole of what an integration
  // is, and the line that passes it to `createWfGraphApp` is what turns it on.
  it("answers a value carrying the credentials and the actions it was given", () => {
    const twilio = aTwilio();

    expect(twilio.kind).toBe("integration");
    expect(twilio.type).toBe("twilio");
    expect(twilio.credentials).toEqual(twilioCredentialFields);
    expect(Object.keys(twilio.actions)).toEqual(["send-sms"]);
    expect(twilio.actions["send-sms"].label).toBe("Send SMS");
  });

  // The slug lives in the record key alone. Nothing here computes the action id,
  // because assembly is where the type and the key are both in hand.
  it("holds no action id of its own", () => {
    expect(aTwilio().actions["send-sms"]).not.toHaveProperty("id");
  });

  // The heading an action is listed under in the selector. Every built-in wanted
  // its integration's own label, so none of them says anything.
  it("heads an action with the integration's label by default", () => {
    expect(aTwilio().actions["send-sms"].category).toBe("Twilio");
  });

  it("lets an action name a heading of its own", () => {
    expect(
      aTwilio({ category: "Messaging" }).actions["send-sms"].category
    ).toBe("Messaging");
  });

  it("holds the Events and webhook it was given", () => {
    const delivered = defineEvent({
      name: "twilio/message.sent",
      schema: Schema.Struct({
        type: Schema.String,
        data: Schema.Struct({ sid: Schema.String }),
      }),
      source: {
        event: "twilio/webhook",
        when: { path: "type", equals: "message.sent" },
      },
    });
    const webhook = {
      source: "twilio/webhook",
      verify: () => Effect.void,
      receive: () => undefined,
    };

    const twilio = defineIntegration({
      type: "twilio",
      label: "Twilio",
      description: "Send SMS messages",
      credentials: twilioCredentialFields,
      events: [delivered],
      webhook,
      actions: {
        "send-sms": {
          label: "Send SMS",
          description: "Sends a message",
          input: Schema.Struct({ to: Schema.String }),
          output: Schema.Struct({
            sid: Schema.String.annotate({ description: "Message SID" }),
          }),
          configFields: [{ key: "to", label: "To", type: "template-input" }],
          handler: Effect.fn(function* () {
            return yield* Effect.succeed({ sid: "SM1" });
          }),
        },
      },
    });

    expect(twilio.events).toEqual([delivered]);
    expect(twilio.webhook).toBe(webhook);
  });

  it("refuses an action declared through the __proto__ literal form", () => {
    expect(() =>
      defineIntegration({
        type: "unsafe",
        label: "Unsafe",
        description: "Uses a prototype-changing action key",
        credentials: {},
        actions: {
          __proto__: {
            label: "Unsafe",
            description: "Must not disappear",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            handler: () => ({}),
          },
        },
      })
    ).toThrow(/actions in an ordinary object record/u);
  });

  it("refuses credentials declared through the __proto__ literal form", () => {
    expect(() =>
      defineIntegration({
        type: "unsafe",
        label: "Unsafe",
        description: "Uses a prototype-changing credential key",
        credentials: {
          __proto__: { label: "Unsafe", type: "password" },
        },
        actions: {},
      })
    ).toThrow(/credentials in an ordinary object record/u);
  });

  it("refuses providers declared through the __proto__ literal form", () => {
    expect(() =>
      defineIntegration({
        type: "unsafe",
        label: "Unsafe",
        description: "Uses a prototype-changing provider key",
        credentials: {},
        configOptions: {
          __proto__: {
            answers: "options",
            load: async () => async () => ({
              status: "options",
              options: [],
            }),
          },
        },
        actions: {},
      })
    ).toThrow(/config options providers in an ordinary object record/u);
  });
});

describe("checkIntegration Events", () => {
  it("refuses a webhook with no Events", () => {
    expect(() =>
      checkIntegration(
        defineIntegration({
          type: "x",
          label: "X",
          description: "Webhook with no Events",
          credentials: {},
          actions: {},
          webhook: {
            source: "x/webhook",
            verify: () => Effect.void,
            receive: () => undefined,
          },
        })
      )
    ).toThrow(/webhook with no Events/u);
  });

  it("refuses an Event whose source is not the webhook's", () => {
    expect(() =>
      checkIntegration(
        defineIntegration({
          type: "x",
          label: "X",
          description: "Mismatched source",
          credentials: {},
          actions: {},
          events: [
            defineEvent({
              name: "x/happened",
              schema: Schema.Struct({
                id: Schema.String.annotate({ description: "Id" }),
              }),
              source: { event: "other/webhook" },
            }),
          ],
          webhook: {
            source: "x/webhook",
            verify: () => Effect.void,
            receive: () => undefined,
          },
        })
      )
    ).toThrow(/not this webhook's source/u);
  });

  it("refuses a webhook secret that is not a credential", () => {
    expect(() =>
      checkIntegration(
        defineIntegration({
          type: "x",
          label: "X",
          description: "Webhook secret is not a credential",
          credentials: {},
          actions: {},
          events: [
            defineEvent({
              name: "x/happened",
              schema: Schema.Struct({
                id: Schema.String.annotate({ description: "Id" }),
              }),
              source: { event: "x/webhook" },
            }),
          ],
          webhook: {
            source: "x/webhook",
            // Deliberately not a declared credential: the type forbids this,
            // and checkIntegration is what still catches a bypass.
            secret: "MISSING_SECRET" as never,
            verify: () => Effect.void,
            receive: () => undefined,
          },
        })
      )
    ).toThrow(/webhook secret "MISSING_SECRET" is not a credential/u);
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

/**
 * What an action literal buys, which is every annotation the previous shape made
 * an author write. These cases compile or they do not; `@ts-expect-error` is the
 * assertion, and an error that stops being raised fails the build.
 *
 * Two actions with different schemas, because a record of one proves nothing
 * about whether each entry is inferred separately.
 */
describe("what an action literal infers", () => {
  it("types each handler from the integration's own credentials and that action's own input", () => {
    const surface = defineIntegration({
      type: "x",
      label: "X",
      description: "Two actions whose schemas disagree",
      credentials: { X_KEY: { label: "Key", type: "password" } },
      actions: {
        first: {
          label: "First",
          description: "Takes a string",
          input: Schema.Struct({ q: Schema.String }),
          output: Schema.Struct({ ok: Schema.Boolean }),
          handler: Effect.fn(function* (bag) {
            expectTypeOf(bag.input).toEqualTypeOf<{ readonly q: string }>();
            expectTypeOf(yield* bag.credentials).toEqualTypeOf<{
              X_KEY?: string;
            }>();
            expectTypeOf(bag.runMode).toEqualTypeOf<"live" | "test">();

            return { ok: bag.input.q.length > 0 };
          }),
        },
        second: {
          label: "Second",
          description: "Takes a number",
          input: Schema.Struct({ r: Schema.Number }),
          output: Schema.Struct({ done: Schema.String }),
          handler: (bag) => {
            // @ts-expect-error `q` is the first action's key, not this one's
            const wrongKey: unknown = bag.input.q;

            return { done: `${String(bag.input.r)}${String(wrongKey ?? "")}` };
          },
        },
      },
    });

    expectTypeOf<keyof typeof surface.actions>().toEqualTypeOf<
      "first" | "second"
    >();
  });

  it("refuses a misspelled credential, a config key no schema declares, and an output the schema does not describe", () => {
    defineIntegration({
      type: "x",
      label: "X",
      description: "Every way an action literal is wrong",
      credentials: { X_KEY: { label: "Key", type: "password" } },
      actions: {
        misspeltCredential: {
          label: "A",
          description: "Reads a credential it never declared",
          input: Schema.Struct({ q: Schema.String }),
          output: Schema.Struct({ ok: Schema.Boolean }),
          handler: Effect.fn(function* (bag) {
            const credentials = yield* bag.credentials;
            // @ts-expect-error the record declares X_KEY and nothing else
            const wrongKey: unknown = credentials.X_KE;

            return { ok: wrongKey === undefined };
          }),
        },
        unknownConfigKey: {
          label: "B",
          description: "Draws a field its handler could never read",
          input: Schema.Struct({ q: Schema.String }),
          output: Schema.Struct({ ok: Schema.Boolean }),
          configFields: [
            // @ts-expect-error `nope` is not a key of this action's input schema
            { key: "nope", label: "Nope", type: "text" },
          ],
          handler: () => ({ ok: true }),
        },
        wrongOutput: {
          label: "C",
          description: "Answers a shape its output schema does not describe",
          input: Schema.Struct({ s: Schema.String }),
          output: Schema.Struct({ n: Schema.Number }),
          // @ts-expect-error the output schema says `{ n: number }`
          handler: (bag) => ({ n: bag.input.s }),
        },
      },
    });
  });
});
