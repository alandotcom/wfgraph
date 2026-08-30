/**
 * The PostHog integration: its credentials, its two actions, and what each takes
 * and gives back.
 *
 * One file, because only the server imports it. The editor gets this plugin's
 * metadata as JSON over `/api/extensions`, so nothing here reaches a browser
 * bundle. The icon is the exception, because a React component cannot be
 * serialized: it stays in `ui.ts`, which only the browser imports.
 *
 * Both actions post to the same endpoint. Capturing an event and identifying a
 * person are one call to PostHog with a different event name, and the split into
 * two actions is for the person configuring them, not for the wire.
 */

import {
  type CredentialFields,
  type CredentialsOf,
  defineIntegration,
  StepFailure,
} from "@wfgraph/core/plugin";
import { Effect, Schema } from "effect";
import {
  captureOrFail,
  connectionFrom,
  eventIdentity,
} from "#src/posthog/capture";
import { posthogOAuth } from "#src/posthog/oauth";
import { readProperties } from "#src/posthog/properties";

const posthogCredentialFields = {
  POSTHOG_PROJECT_API_KEY: {
    label: "Project API Key",
    type: "password",
    placeholder: "phc_...",
    helpText: "Find your project API key in ",
    helpLink: {
      text: "PostHog project settings",
      url: "https://posthog.com/docs/api/capture",
    },
  },
  POSTHOG_HOST: {
    label: "API Host",
    type: "url",
    placeholder: "https://us.i.posthog.com",
    helpText:
      "https://us.i.posthog.com for US Cloud, https://eu.i.posthog.com for EU Cloud, or your own domain. Blank means US Cloud.",
  },
} satisfies CredentialFields;

export type PostHogCredentials = CredentialsOf<typeof posthogCredentialFields>;

type PostHogTestBehavior = "log_only" | "send";

/** The distinct id PostHog will not accept an event without. */
const MISSING_DISTINCT_ID =
  "distinctId resolved to nothing. PostHog needs a distinct id to attach the event to a person.";

/**
 * The Capture Event config, as the step reads it.
 *
 * Every field is a string because that is what a resolved config field is: the
 * editor writes text, and a template variable resolves to text. `optionalKey` for
 * a field a builder may leave blank, which reaches a step as an absent key.
 */
const captureEventInput = Schema.Struct({
  eventName: Schema.String,
  distinctId: Schema.String,
  /** The key-value widget's rows, as JSON the step parses. */
  properties: Schema.optionalKey(Schema.String),
  /** JSON the workflow author typed, for a property that is not a string. */
  propertiesJson: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.String),
  personProfile: Schema.optionalKey(Schema.String),
  testBehavior: Schema.optionalKey(Schema.String),
});

/** The Identify Person config. `$set` and `$set_once` are PostHog's own names. */
const identifyPersonInput = Schema.Struct({
  distinctId: Schema.String,
  setProperties: Schema.optionalKey(Schema.String),
  setPropertiesJson: Schema.optionalKey(Schema.String),
  setOnceProperties: Schema.optionalKey(Schema.String),
  testBehavior: Schema.optionalKey(Schema.String),
});

/**
 * What a captured event leaves for the nodes downstream of it.
 *
 * PostHog answers nothing that identifies the event, so what is worth passing on
 * is what this step decided: the uuid it minted, which is what the event can be
 * found by, and the timestamp it was stamped with.
 *
 * `optionalKey(NullOr(...))` on the way out, which is the one spelling that
 * survives both a key the handler leaves out and a null it writes.
 */
const captureEventOutput = Schema.Struct({
  eventName: Schema.String.annotate({ description: "Event name" }),
  distinctId: Schema.String.annotate({ description: "Person distinct ID" }),
  eventUuid: Schema.String.annotate({ description: "Event UUID" }),
  timestamp: Schema.String.annotate({ description: "Event timestamp" }),
  /** Absent on a real capture: this is why a test run made none. */
  reasonCode: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.annotate({ description: "Why a test run did not capture" })
    )
  ),
});

const identifyPersonOutput = Schema.Struct({
  distinctId: Schema.String.annotate({ description: "Person distinct ID" }),
  eventUuid: Schema.String.annotate({ description: "Event UUID" }),
  timestamp: Schema.String.annotate({ description: "Event timestamp" }),
  reasonCode: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.annotate({ description: "Why a test run did not identify" })
    )
  ),
});

function resolvePostHogTestBehavior(
  value: string | undefined
): PostHogTestBehavior {
  return value === "send" ? "send" : "log_only";
}

export const posthog = defineIntegration({
  type: "posthog",
  label: "PostHog",
  description: "Capture product analytics events and identify people",
  credentials: posthogCredentialFields,
  oauth: posthogOAuth,

  // The connection test reaches PostHog, so it stays behind a dynamic import
  // until someone presses "Test connection".
  test: async () => (await import("#src/posthog/test")).testPostHog,

  actions: {
    "capture-event": {
      label: "Capture Event",
      description: "Send an event to PostHog",
      sideEffect: true,
      input: captureEventInput,
      output: captureEventOutput,
      configFields: [
        {
          key: "eventName",
          label: "Event Name",
          type: "template-input",
          placeholder: "user_signed_up",
          example: "user_signed_up",
          required: true,
        },
        {
          key: "distinctId",
          label: "Distinct ID",
          type: "template-input",
          placeholder: "The person this event belongs to",
          example: "user_12345",
          required: true,
        },
        {
          key: "properties",
          label: "Properties",
          type: "key-value",
        },
        {
          key: "personProfile",
          label: "Person Profile",
          type: "select",
          defaultValue: "identified",
          options: [
            { value: "identified", label: "Identified (creates a person)" },
            { value: "anonymous", label: "Anonymous (no person profile)" },
          ],
        },
        {
          key: "testBehavior",
          label: "Test Mode Behavior",
          type: "select",
          defaultValue: "log_only",
          options: [
            { value: "log_only", label: "Log only (do nothing)" },
            { value: "send", label: "Capture a real event" },
          ],
        },
        {
          type: "group",
          label: "Advanced",
          fields: [
            {
              key: "propertiesJson",
              label: "Properties JSON",
              type: "template-textarea",
              placeholder:
                'For a property that is not text: {"plan": "pro", "seats": 12, "trial": false}',
              rows: 4,
              example: '{"seats": 12}',
            },
            {
              key: "timestamp",
              label: "Timestamp (ISO 8601)",
              type: "template-input",
              placeholder: "Blank means the moment the step runs",
              example: "2024-12-25T09:00:00Z",
            },
          ],
        },
      ],
      handler: Effect.fn(function* (bag) {
        const { input } = bag;
        const testBehavior = resolvePostHogTestBehavior(input.testBehavior);

        // A test run captures nothing unless the builder asked it to, so a
        // workflow being built does not skew the project's own numbers. The
        // answer is a success carrying the reason, so the run shows what
        // happened rather than an error someone has to interpret.
        if (bag.runMode === "test" && testBehavior === "log_only") {
          return {
            eventName: input.eventName,
            distinctId: input.distinctId,
            eventUuid: "",
            timestamp: "",
            reasonCode: "test_mode_log_only",
          };
        }

        // Read late, so a test run deciding it has nothing to capture never
        // touches the integration's secrets.
        const connection = yield* connectionFrom(yield* bag.credentials);

        // Both fields are required in the form, but a template resolving to
        // nothing still arrives blank. PostHog would take the event and file it
        // against a person nobody can find, so it is refused here instead.
        const eventName = input.eventName.trim();
        const distinctId = input.distinctId.trim();

        if (!eventName) {
          return yield* new StepFailure({
            message:
              "eventName resolved to nothing. PostHog needs an event name.",
          });
        }

        if (!distinctId) {
          return yield* new StepFailure({ message: MISSING_DISTINCT_ID });
        }

        const identity = yield* bag.step.run("identity", eventIdentity);
        const timestamp = input.timestamp?.trim() || identity.timestamp;
        const authored = yield* readProperties(
          input.properties,
          input.propertiesJson,
          "drop"
        );

        // An anonymous event is one PostHog files without building a person
        // profile, which is what its own property name says.
        const properties =
          input.personProfile === "anonymous"
            ? { ...authored, $process_person_profile: false }
            : authored;

        yield* bag.step.run(
          "capture",
          captureOrFail("Failed to capture event", connection, {
            event: eventName,
            distinct_id: distinctId,
            uuid: identity.uuid,
            timestamp,
            ...(properties ? { properties } : {}),
          })
        );

        return {
          eventName,
          distinctId,
          eventUuid: identity.uuid,
          timestamp,
        };
      }),
    },

    "identify-person": {
      label: "Identify Person",
      description: "Set properties on a person in PostHog",
      sideEffect: true,
      input: identifyPersonInput,
      output: identifyPersonOutput,
      configFields: [
        {
          key: "distinctId",
          label: "Distinct ID",
          type: "template-input",
          placeholder: "The person to identify",
          example: "user_12345",
          required: true,
        },
        {
          key: "setProperties",
          label: "Set Properties (overwrites)",
          type: "key-value",
        },
        {
          key: "setOnceProperties",
          label: "Set Once (keeps any existing value)",
          type: "key-value",
        },
        {
          key: "testBehavior",
          label: "Test Mode Behavior",
          type: "select",
          defaultValue: "log_only",
          options: [
            { value: "log_only", label: "Log only (do nothing)" },
            { value: "send", label: "Identify for real" },
          ],
        },
        {
          type: "group",
          label: "Advanced",
          fields: [
            {
              key: "setPropertiesJson",
              label: "Set Properties JSON",
              type: "template-textarea",
              placeholder:
                'For a property that is not text: {"plan": "pro", "seats": 12}',
              rows: 4,
              example: '{"seats": 12}',
            },
          ],
        },
      ],
      handler: Effect.fn(function* (bag) {
        const { input } = bag;
        const testBehavior = resolvePostHogTestBehavior(input.testBehavior);

        if (bag.runMode === "test" && testBehavior === "log_only") {
          return {
            distinctId: input.distinctId,
            eventUuid: "",
            timestamp: "",
            reasonCode: "test_mode_log_only",
          };
        }

        const connection = yield* connectionFrom(yield* bag.credentials);
        const distinctId = input.distinctId.trim();

        if (!distinctId) {
          return yield* new StepFailure({ message: MISSING_DISTINCT_ID });
        }

        const set = yield* readProperties(
          input.setProperties,
          input.setPropertiesJson,
          "fail"
        );
        const setOnce = yield* readProperties(
          input.setOnceProperties,
          undefined,
          "fail"
        );

        // An identify carrying neither bag would create a bare person profile
        // and say nothing about them, which is never what the builder meant.
        if (!(set || setOnce)) {
          return yield* new StepFailure({
            message:
              "Identify Person needs at least one property to set. Add a row to Set Properties or Set Once.",
          });
        }

        const identity = yield* bag.step.run("identity", eventIdentity);

        yield* bag.step.run(
          "identify",
          captureOrFail("Failed to identify person", connection, {
            event: "$identify",
            distinct_id: distinctId,
            uuid: identity.uuid,
            timestamp: identity.timestamp,
            ...(set ? { $set: set } : {}),
            ...(setOnce ? { $set_once: setOnce } : {}),
          })
        );

        return {
          distinctId,
          eventUuid: identity.uuid,
          timestamp: identity.timestamp,
        };
      }),
    },
  },
});
