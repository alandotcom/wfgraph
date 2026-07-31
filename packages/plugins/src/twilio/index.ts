/**
 * The Twilio integration: its credentials, its actions, and what each action
 * does.
 *
 * One file, because only the server imports it. The editor gets this plugin's
 * metadata as JSON over `/api/extensions`, so nothing here reaches a browser
 * bundle and the vendor client below costs the browser nothing. The icon is the
 * exception, since a React component cannot be serialized: it stays in `ui.ts`,
 * which only the browser imports.
 */

import {
  credentialFields,
  type CredentialsOf,
  defineIntegration,
  defineStep,
  StepFailure,
  type StepRunContext,
} from "@rova/core/plugin";
import { Effect, Schema, SchemaTransformation } from "effect";
import { createTwilioMessage, describeTwilioFailure } from "#src/twilio/client";

// `credentialFields` exists for the `const` inference: each `envVar` has to stay
// a literal type, because the credential vocabulary below is derived from them.
const twilioCredentialFields = credentialFields([
  {
    label: "Account SID",
    type: "text",
    placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    configKey: "accountSid",
    envVar: "TWILIO_ACCOUNT_SID",
    helpText: "Find this in your Twilio Console.",
  },
  {
    label: "Auth Token",
    type: "password",
    placeholder: "••••••••",
    configKey: "authToken",
    envVar: "TWILIO_AUTH_TOKEN",
    helpText: "Keep this secret. Used for Basic auth to Twilio API.",
  },
  {
    label: "Default From Number",
    type: "text",
    placeholder: "+15551234567",
    configKey: "fromNumber",
    envVar: "TWILIO_FROM_NUMBER",
    helpText: "Optional fallback sender number.",
  },
  {
    label: "Default Messaging Service SID",
    type: "text",
    placeholder: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    configKey: "messagingServiceSid",
    envVar: "TWILIO_MESSAGING_SERVICE_SID",
    helpText: "Optional fallback if From is not provided.",
  },
]);

export type TwilioCredentials = CredentialsOf<typeof twilioCredentialFields>;

type TwilioTestBehavior = "log_only" | "send_to_test_phone";
const E164_PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

/**
 * A list carried by one text field, which is the only shape a config field has.
 *
 * The split is a transform on the schema rather than a helper the handler calls:
 * a step's input is decoded through its canonical JSON codec, so a handler
 * receives the list and nothing in it has to know the field was ever text.
 */
const commaSeparatedUrls = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transform<readonly string[], string>({
      decode: (value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      encode: (entries) => entries.join(","),
    })
  )
);

/**
 * The Send SMS config, as the step reads it.
 *
 * Almost every field is a string because that is what a resolved config field
 * is: the editor writes text, and a template variable resolves to text. Which of
 * them a builder has to fill in is stated in `configFields`; what this schema
 * says is what the step may read.
 *
 * `optional`, not `optionalKey`: the engine resolves a node's templates into
 * every config key the action declares, so a field left blank arrives as a key
 * holding `undefined` rather than as no key at all. Exact-optional semantics
 * would reject the config a real run builds.
 */
const sendSmsInput = Schema.Struct({
  smsTo: Schema.String,
  smsBody: Schema.String,
  smsFrom: Schema.optional(Schema.String),
  smsMessagingServiceSid: Schema.optional(Schema.String),
  smsStatusCallback: Schema.optional(Schema.String),
  smsMediaUrls: Schema.optional(commaSeparatedUrls),
  testBehavior: Schema.optional(Schema.String),
  testPhoneTo: Schema.optional(Schema.String),
});

/**
 * What a sent message leaves for the nodes downstream of it.
 *
 * `optionalKey(NullOr(...))` throughout, which is the one spelling that survives
 * everything: a key the handler leaves out on the test-mode paths, and a null it
 * writes where Twilio sent no number. The encode refuses a key that is present and
 * holds `undefined`, which is why the handler writes the null.
 */
const sendSmsOutput = Schema.Struct({
  sid: Schema.String.annotate({ description: "Message SID" }),
  status: Schema.String.annotate({ description: "Delivery status" }),
  to: Schema.String.annotate({ description: "Recipient phone number" }),
  from: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.annotate({ description: "Sender phone number" })
    )
  ),
  messagingServiceSid: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.annotate({ description: "Messaging Service SID" })
    )
  ),
  /** Absent on a real send: this is why a test run did not make one. */
  reasonCode: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.annotate({ description: "Why a test run did not send" })
    )
  ),
});

function resolveTwilioTestBehavior(
  value: string | undefined
): TwilioTestBehavior {
  return value === "send_to_test_phone" ? "send_to_test_phone" : "log_only";
}

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies: what this step decides is which of five things to send, and every
 * one of those decisions is here.
 */
export const sendSmsHandler = Effect.fn(function* (
  input: typeof sendSmsInput.Type,
  context: StepRunContext<TwilioCredentials>
) {
  const executionId = context.executionId ?? "no_execution";
  const testBehavior = resolveTwilioTestBehavior(input.testBehavior);

  // A test run either sends nothing at all or sends to one number the builder
  // nominated. Both answers are a success carrying the reason, so the run shows
  // what happened rather than an error someone has to interpret.
  if (context.runMode === "test" && testBehavior === "log_only") {
    return {
      sid: `twilio:test-log-only:${executionId}`,
      status: "queued",
      to: input.smsTo,
      reasonCode: "test_mode_log_only",
    };
  }

  const testPhone = input.testPhoneTo?.trim() ?? "";
  const routeToTestPhone =
    context.runMode === "test" && testBehavior === "send_to_test_phone";

  if (routeToTestPhone && testPhone.length === 0) {
    return {
      sid: `twilio:test-log-fallback:${executionId}`,
      status: "queued",
      to: input.smsTo,
      reasonCode: "test_mode_log_fallback_missing_test_phone",
    };
  }

  if (routeToTestPhone && !E164_PHONE_PATTERN.test(testPhone)) {
    return {
      sid: `twilio:test-log-fallback:${executionId}`,
      status: "queued",
      to: input.smsTo,
      reasonCode: "test_mode_log_fallback_invalid_test_phone",
    };
  }

  // A key this integration never declares is a compile error here rather than an
  // undefined at run time.
  const credentials = yield* context.credentials;
  const accountSid = credentials.TWILIO_ACCOUNT_SID;
  const authToken = credentials.TWILIO_AUTH_TOKEN;

  if (!(accountSid && authToken)) {
    return yield* new StepFailure({
      message:
        "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required. Add them in Project Integrations.",
    });
  }

  const senderFrom = input.smsFrom || credentials.TWILIO_FROM_NUMBER;
  const senderMessagingServiceSid =
    input.smsMessagingServiceSid || credentials.TWILIO_MESSAGING_SERVICE_SID;

  if (!(senderFrom || senderMessagingServiceSid)) {
    return yield* new StepFailure({
      message:
        "Either From number or Messaging Service SID is required. Configure one in the action or integration settings.",
    });
  }

  const recipient = routeToTestPhone ? testPhone : input.smsTo;

  if (!(recipient && input.smsBody)) {
    return yield* new StepFailure({
      message: "smsTo and smsBody are required",
    });
  }

  const mediaUrls = input.smsMediaUrls ?? [];

  // Twilio's own parameter names, so this reads like its documentation. The
  // client drops the ones left undefined and expands MediaUrl into the repeated
  // key the form encoding uses for a list.
  const message = yield* createTwilioMessage(
    { accountSid, authToken },
    {
      To: recipient,
      Body: input.smsBody,
      From: senderFrom || undefined,
      MessagingServiceSid: senderMessagingServiceSid || undefined,
      StatusCallback: input.smsStatusCallback || undefined,
      MediaUrl: mediaUrls.length > 0 ? [...mediaUrls] : undefined,
    }
  ).pipe(
    Effect.mapError(
      (error) => new StepFailure({ message: describeTwilioFailure(error) })
    )
  );

  return {
    sid: message.sid,
    status: message.status,
    to: message.to,
    from: message.from ?? null,
    messagingServiceSid: message.messaging_service_sid ?? null,
  };
});

export const twilio = defineIntegration({
  type: "twilio",
  label: "Twilio",
  description: "Send SMS messages with Twilio Programmable Messaging",
  credentials: twilioCredentialFields,

  // The connection test reaches Twilio, so it stays behind a dynamic import
  // until someone presses "Test connection".
  test: async () => (await import("#src/twilio/test")).testTwilio,

  // The record key is the action slug. It is the only place the slug exists, so
  // the action id "twilio/send-sms" is computed and never written twice.
  actions: {
    "send-sms": defineStep({
      label: "Send SMS",
      description: "Send an SMS via Twilio",
      category: "Twilio",
      input: sendSmsInput,
      output: sendSmsOutput,
      // Each `key` is checked against the input schema, so a field the step
      // cannot read fails to compile.
      configFields: [
        {
          key: "smsTo",
          label: "To",
          type: "template-input",
          placeholder: "+15551234567",
          required: true,
        },
        {
          key: "testBehavior",
          label: "Test Mode Behavior",
          type: "select",
          defaultValue: "log_only",
          options: [
            { value: "log_only", label: "Log only (do nothing)" },
            { value: "send_to_test_phone", label: "Send to test phone" },
          ],
        },
        {
          key: "testPhoneTo",
          label: "Test Phone Number",
          type: "text",
          placeholder: "+15557654321",
          // Literal: a run's own payload must not steer the test send.
          literal: true,
          showWhen: {
            field: "testBehavior",
            equals: "send_to_test_phone",
          },
        },
        {
          key: "smsBody",
          label: "Message",
          type: "template-textarea",
          placeholder: "Hi from workflow {{PreviousNode.value}}",
          rows: 4,
          required: true,
        },
        {
          type: "group",
          label: "Sender",
          defaultExpanded: true,
          fields: [
            {
              key: "smsFrom",
              label: "From Number",
              type: "template-input",
              placeholder: "+15557654321",
            },
            {
              key: "smsMessagingServiceSid",
              label: "Messaging Service SID",
              type: "template-input",
              placeholder: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            },
          ],
        },
        {
          type: "group",
          label: "Advanced",
          fields: [
            {
              key: "smsStatusCallback",
              label: "Status Callback URL",
              type: "template-input",
              placeholder: "https://example.com/twilio/status",
            },
            {
              key: "smsMediaUrls",
              label: "Media URLs (comma separated)",
              type: "template-input",
              placeholder: "https://example.com/image.png",
            },
          ],
        },
      ],
      handler: sendSmsHandler,
    }),
  },
});
