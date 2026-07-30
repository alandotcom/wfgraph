# The extension surface: explicit assembly, registration by value

Status: approved by the product owner as the design of record. B1 has landed and B2 is in
flight; every later batch is unstarted. Section 10 says which is which.

Vocabulary authority: `CONTEXT.md` and `docs/adr/0007-lifecycle-rules-replace-the-routing-policy.md`.
This document uses Event, Correlation Path, Entity Value, Lifecycle Rules, Lifecycle Node,
Start Event, Cancel Event, Concurrency, Superseded, Canceled Branch, Precedence, Wait
Subscription, and Execution with the meanings those two files give them, and does not
restate them. Read both before implementing any part of this.

Also required reading: `AGENTS.md` for the conventions every code sample here obeys, and
`docs/adr/0002-effect-v4-beta-with-a-promise-seam-at-the-embedder-surfaces.md` for the
stage numbering used in the batch plan.

Section 2.3 is the schema contract, and it is the one section whose claims are all
citations. Before changing anything it describes, read
`.repos/effect/packages/effect/SCHEMA.md`, which is the authoritative v4 Schema guide, at
least its "Serialization" and "Schema Generation and Tooling" chapters. Every API claim in
2.3 cites that file or `.repos/effect/packages/effect/src/Schema.ts` by line, and each was
also run against the installed `effect@4.0.0-beta.102`. Do not take any of it from memory,
and do not take a replacement from memory either.

---

## 1. Overview

### 1.1 The problem

Adding an integration means touching four files joined by a string. The action id
`"twilio/send-sms"` is written in `packages/plugins/src/twilio/index.ts` as a slug, in
`steps/send-sms.ts` as a `defineStep` id, and in `packages/plugins/src/server.ts` as a
registration key. Every registry fills itself by import side effect, which is why
`packages/shared/src/plugins/registry.ts` and `action-registry.ts` keep their state on
`globalThis` behind `Symbol.for`: the same module exists in two bundles, and the
registration has to reach both. Nothing proves a declared action has an implementation.
The `IntegrationType` union in `packages/shared/src/types/integration.ts` is hand-kept,
and so is the import list in `packages/plugins/src/index.ts`.

Two bugs come out of the same root. A Wait node can only offer event names its
workflow's trigger declared, because event names exist only inside `createTrigger` and no
event registry exists. And a trigger's payload fields reach the browser correctly but the
template picker drops them, because the picker prepends three synthetic fields and filters
a timestamp target down to fields typed `timestamp`, which no payload field can be.

### 1.2 The shape

Nothing registers itself. `defineEvent`, `defineAction`, and `defineIntegration` return
plain typed values. The host app passes them to `createRovaApp`, which assembles one
immutable `ExtensionSet`. That set has two halves: an `ExtensionCatalog`, which is JSON and
crosses the wire, and the implementations, which stay on the server.

`GET /api/extensions` serves the catalog and is the only channel the browser learns the
surface through. This is the decision that resolves "see a plugin in one file" against the
browser/server split. A plugin definition file may hold its metadata, its schemas, its
handler, and its vendor imports together, because the browser never imports it.

Events are first-class values. A Wait node subscribes to any Event by name. An Event
imported from an existing Inngest bus is waitable with no lifecycle role at all. Per
ADR-0007 the authored trigger dissolves: an Event carries its Correlation Path, and the
Workflow Builder owns every lifecycle decision on the Lifecycle Node.

### 1.3 Decisions already made

These are settled. Do not relitigate them during implementation.

1. **One Event per name.** An app writes three `defineEvent` calls for created,
   rescheduled, and canceled. Section 3.2 has the reasoning and the escape hatch for an
   umbrella bus.
2. **HTTP intake is one app-level route,** `POST /api/events/:eventName`. The per-workflow
   webhook URL retires. There is no event-path or event-map channel.
3. **A scheduled or manual start uses the workflow itself as its Entity Value.**
4. **Run history hides superseded Executions by default,** behind a count toggle.
5. **The event-wait timeout is required,** with an editor default of 7 days.
6. **The Canceled outlet lands inside the stage 7 batch,** not before. Until it lands the
   Lifecycle panel refuses Cancel Events with an explanatory message. Section 9 says why.
7. **A schema with a transform runs as a codec at Rova's seams.** An author passes one and
   gets the decoded type in a handler and the encoded form on every wire. Section 2.3 has
   the contract, the call sites, and the one API that makes it work.
8. **An Event payload decodes open.** Declared fields are validated and unknown keys are
   ignored rather than refused. This is a deliberate exception to the repo-wide
   `rejectUnknownKeys` convention, which stands everywhere else. Section 2.3 has the
   reasoning and the consequence.

---

## 2. The authoring surface

### 2.1 A plugin, in one file

`packages/plugins/src/twilio/index.ts`. The Advanced config group is trimmed for length.
Everything else is the live plugin.

```ts
/**
 * The Twilio integration: its credentials, its actions, and what each action
 * does. One file, because only the server imports it. The editor gets this
 * plugin's metadata as JSON over /api/extensions, so nothing here reaches a
 * browser bundle and a vendor import costs the browser nothing.
 */

import {
  credentialFields,
  type CredentialsOf,
  defineIntegration,
  defineStep,
  StepFailure,
  type StepRunContext,
} from "@rova/core/plugin";
import { Effect, Schema } from "effect";
import { createTwilioMessage, describeTwilioFailure } from "#src/twilio/client";

// `credentialFields` exists for the `const` inference: the envVar strings have
// to stay literal types, because the credential vocabulary below is derived
// from them.
const twilioCredentialFields = credentialFields([
  {
    id: "accountSid",
    label: "Account SID",
    type: "text",
    placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    configKey: "accountSid",
    envVar: "TWILIO_ACCOUNT_SID",
    helpText: "Find this in your Twilio Console.",
  },
  {
    id: "authToken",
    label: "Auth Token",
    type: "password",
    placeholder: "••••••••",
    configKey: "authToken",
    envVar: "TWILIO_AUTH_TOKEN",
    helpText: "Keep this secret. Used for Basic auth to Twilio API.",
  },
  {
    id: "fromNumber",
    label: "Default From Number",
    type: "text",
    placeholder: "+15551234567",
    configKey: "fromNumber",
    envVar: "TWILIO_FROM_NUMBER",
  },
  {
    id: "messagingServiceSid",
    label: "Default Messaging Service SID",
    type: "text",
    placeholder: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    configKey: "messagingServiceSid",
    envVar: "TWILIO_MESSAGING_SERVICE_SID",
  },
]);

/** The keys a Twilio handler may read, derived from the fields above. */
export type TwilioCredentials = CredentialsOf<typeof twilioCredentialFields>;

const E164_PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

const sendSmsInput = Schema.Struct({
  smsTo: Schema.String,
  smsBody: Schema.String,
  smsFrom: Schema.optional(Schema.String),
  smsMessagingServiceSid: Schema.optional(Schema.String),
  smsStatusCallback: Schema.optional(Schema.String),
  smsMediaUrls: Schema.optional(Schema.String),
  testBehavior: Schema.optional(Schema.String),
  testPhoneTo: Schema.optional(Schema.String),
});

const sendSmsOutput = Schema.Struct({
  sid: Schema.String.annotate({ description: "Message SID" }),
  status: Schema.String.annotate({ description: "Delivery status" }),
  to: Schema.String.annotate({ description: "Recipient phone number" }),
  from: Schema.optional(
    Schema.String.annotate({ description: "Sender phone number" })
  ),
  messagingServiceSid: Schema.optional(
    Schema.String.annotate({ description: "Messaging Service SID" })
  ),
  reasonCode: Schema.optional(
    Schema.String.annotate({ description: "Why a test run did not send" })
  ),
});

export const twilio = defineIntegration({
  type: "twilio",
  label: "Twilio",
  description: "Send SMS messages with Twilio Programmable Messaging",
  credentials: twilioCredentialFields,

  // The connection test reaches Twilio, so it stays behind a dynamic import
  // until someone presses "Test connection".
  test: async () => (await import("#src/twilio/test")).testTwilio,

  // The record key is the action slug. It is the only place the slug exists,
  // so the action id "twilio/send-sms" is computed and never written twice.
  actions: {
    "send-sms": defineStep({
      label: "Send SMS",
      description: "Send an SMS via Twilio",
      category: "Twilio",
      input: sendSmsInput,
      output: sendSmsOutput,
      // Each `key` is checked against the input schema, so a config field the
      // step cannot read fails to compile.
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
          showWhen: { field: "testBehavior", equals: "send_to_test_phone" },
        },
        {
          key: "smsBody",
          label: "Message",
          type: "template-textarea",
          rows: 4,
          required: true,
        },
        {
          type: "group",
          label: "Sender",
          defaultExpanded: true,
          fields: [
            { key: "smsFrom", label: "From Number", type: "template-input" },
            {
              key: "smsMessagingServiceSid",
              label: "Messaging Service SID",
              type: "template-input",
            },
          ],
        },
      ],
      handler: Effect.fn(function* (
        input,
        context: StepRunContext<TwilioCredentials>
      ) {
        const executionId = context.executionId ?? "no_execution";
        const routeToTestPhone =
          context.runMode === "test" &&
          input.testBehavior === "send_to_test_phone";

        // A test run either sends nothing or sends to one nominated number.
        // Both answers are a success carrying the reason.
        if (context.runMode === "test" && !routeToTestPhone) {
          return {
            sid: `twilio:test-log-only:${executionId}`,
            status: "queued",
            to: input.smsTo,
            reasonCode: "test_mode_log_only",
          };
        }

        const testPhone = input.testPhoneTo?.trim() ?? "";
        if (routeToTestPhone && !E164_PHONE_PATTERN.test(testPhone)) {
          return {
            sid: `twilio:test-log-fallback:${executionId}`,
            status: "queued",
            to: input.smsTo,
            reasonCode: "test_mode_log_fallback_invalid_test_phone",
          };
        }

        // A key the plugin does not declare is a compile error here.
        const credentials = yield* context.credentials;
        const accountSid = credentials.TWILIO_ACCOUNT_SID;
        const authToken = credentials.TWILIO_AUTH_TOKEN;

        if (!(accountSid && authToken)) {
          return yield* Effect.fail(
            new StepFailure({
              message:
                "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required. Add them in Project Integrations.",
            })
          );
        }

        const senderFrom = input.smsFrom || credentials.TWILIO_FROM_NUMBER;
        const senderService =
          input.smsMessagingServiceSid ||
          credentials.TWILIO_MESSAGING_SERVICE_SID;

        if (!(senderFrom || senderService)) {
          return yield* Effect.fail(
            new StepFailure({
              message:
                "Either From number or Messaging Service SID is required.",
            })
          );
        }

        const message = yield* createTwilioMessage(
          { accountSid, authToken },
          {
            To: routeToTestPhone ? testPhone : input.smsTo,
            Body: input.smsBody,
            From: senderFrom || undefined,
            MessagingServiceSid: senderService || undefined,
            StatusCallback: input.smsStatusCallback || undefined,
          }
        ).pipe(
          Effect.mapError(
            (error) =>
              new StepFailure({ message: describeTwilioFailure(error) })
          )
        );

        return {
          sid: message.sid,
          status: message.status,
          to: message.to,
          from: message.from ?? undefined,
          messagingServiceSid: message.messaging_service_sid ?? undefined,
        };
      }),
    }),
  },
});
```

Four files collapse into one. Today's `index.ts`, `schemas.ts`, `credentials.ts`, and the
plugin's lines in `server.ts` become this file, beside `client.ts`, `test.ts`, and
`icon.tsx`.

An action whose handler is long enough to want its own module takes `load` in place of
`handler`. The two are the arms of a union, so exactly one is required:

```ts
"send-sms": defineStep({
  label: "Send SMS",
  input: sendSmsInput,      // must live where both files can see it
  output: sendSmsOutput,
  configFields: [...],
  load: async () => (await import("#src/twilio/steps/send-sms")).sendSms,
}),
```

`handler` is the documented default and what all six built-ins use after the port. The
three built-ins that keep a vendor SDK (clerk, linear, acuity) move that SDK import inside
their own `client.ts`, behind a cached dynamic import, so `builtInIntegrations` stays cheap
to import:

```ts
// packages/plugins/src/clerk/client.ts
// The SDK is heavy and most processes never call it, so it loads on first use
// rather than at import. `Effect.cached` makes that happen once.
const clerkSdk = Effect.cached(
  Effect.promise(async () => (await import("@clerk/backend")).createClerkClient)
);
```

### 2.2 The example app, in full

`examples/app.ts`. This is the whole file. Per ADR-0006 the bar for a line in it is whether
an adopter would write it.

```ts
/**
 * The Rova app this repo runs, for `pnpm run dev` and for `pnpm run start`.
 *
 * The repo has no server of its own. `createRovaApp` returns a fetch handler and
 * the host mounts it, so the only server here is an adopter's app, written the
 * way an adopter writes one. Running it is what keeps the published path
 * exercised: every line below is a line someone embedding Rova would also write,
 * and anything that would exist only to serve this repo's dev loop belongs
 * somewhere else.
 *
 * The Events and the custom action are the interesting half. They show what
 * `defineEvent` and `defineAction` are for, and Rova serves them beside its
 * built-in integrations with no further registration.
 *
 * Development hands over no editor. `pnpm run dev` runs Vite's dev server in
 * packages/client, which compiles the SPA and proxies `/api` here, so there is
 * no built bundle to pass. Production has one, and passing it is what turns the
 * editor on.
 */

// First, so the rest of the graph loads with .env already applied.
import "../load-env";
import { createServer } from "node:http";
import {
  dateField,
  defineAction,
  defineEvent,
  timestampField,
} from "@rova/core";
import { createRovaApp } from "@rova/core/app";
import { createRequestListener } from "@rova/core/node";
// The built-in integrations, as values. Nothing registers on import, so this
// line is what turns them on and dropping it is what turns them off.
import { builtInIntegrations } from "@rova/plugins";
import { Schema } from "effect";

const DEFAULT_PORT = 4017;
const DEFAULT_DATABASE_URL =
  "postgresql://workflow:workflow@localhost:55437/workflow_builder";

const isProduction = process.env.NODE_ENV === "production";

// An annotation is what a field's label comes from: the editor renders
// `description` off the JSON Schema, so the same annotation that documents a
// field here is what an operator reads beside the input. It goes on the base
// type before any check, because a check would otherwise own it.
const appointmentIdSchema = Schema.String.annotate({
  description: "Appointment ID",
});

// `timestampField` carries the `format: "date-time"` keyword and the ISO check
// together, both on the base type. The editor reads the keyword, so a field
// written this way is offered wherever a timestamp is wanted and gets timestamp
// operators in the condition builder.
const appointment = Schema.Struct({
  id: appointmentIdSchema,
  startsAt: timestampField("When the appointment starts"),
  patientName: Schema.String.annotate({ description: "Patient name" }),
  status: Schema.String.annotate({ description: "Appointment status" }),
}).annotate({ description: "The appointment this event is about" });

const occurredAt = timestampField("When the event was raised");

/**
 * An Event: a name, a payload shape, and where the payload carries its Entity
 * Value. It holds no lifecycle role. Which workflow starts on it, and which
 * cancels on it, is each Workflow Builder's decision in the editor.
 *
 * Send it from your app:
 *
 *   inngest.send({ name: "app/appointment.created", data: { appointment, occurredAt } });
 *
 * Or post it, which needs no Inngest client:
 *
 *   POST /api/events/app%2Fappointment.created
 */
const appointmentCreated = defineEvent({
  name: "app/appointment.created",
  label: "Appointment created",
  description: "Raised when a new appointment is booked.",
  schema: Schema.Struct({ appointment, occurredAt }),
  correlationPath: "appointment.id",
});

const appointmentRescheduled = defineEvent({
  name: "app/appointment.rescheduled",
  label: "Appointment rescheduled",
  description: "Raised when an appointment moves to a new time.",
  schema: Schema.Struct({
    appointment,
    occurredAt,
    previousStartsAt: timestampField("The time it was moved from"),
  }),
  correlationPath: "appointment.id",
});

const appointmentCanceled = defineEvent({
  name: "app/appointment.canceled",
  label: "Appointment canceled",
  description: "Raised when an appointment is called off.",
  schema: Schema.Struct({
    appointment,
    occurredAt,
    reason: Schema.String.annotate({ description: "Why it was canceled" }),
  }),
  correlationPath: "appointment.id",
});

/**
 * An Event no workflow starts on.
 *
 * This app's billing service already sends it. Declaring it makes it available
 * to a Wait node, so a run parked after "send the invoice" resumes when the
 * payment settles. An Event needs no lifecycle role to wake a wait.
 *
 * Its Correlation Path names a different field from the appointment Events, and
 * they still describe the same entity: agreement is by value, not by path.
 */
const paymentSettled = defineEvent({
  name: "billing/payment.settled",
  label: "Payment settled",
  description: "Raised by the billing service when a charge clears.",
  schema: Schema.Struct({
    appointmentId: appointmentIdSchema,
    amountCents: Schema.Number.annotate({
      description: "Amount settled, in cents",
    }).check(Schema.isFinite()),
    settledAt: timestampField("When the payment settled"),
  }),
  correlationPath: "appointmentId",
});

const cancelAppointment = defineAction({
  id: "appointments/cancel",
  label: "Cancel Appointment",
  description: "Cancels an appointment and records the cancellation reason.",
  category: "Appointments",
  input: Schema.Struct({
    appointmentId: appointmentIdSchema,
    reason: Schema.String.annotate({
      description: "Cancellation reason",
    }).check(Schema.isMinLength(1)),
  }),
  // What the action returns, described the same way its input is. The editor's
  // template picker is derived from this, so there is no field list to keep in
  // step. Every field is annotated for the same reason the input's are: the
  // annotation is what an operator reads beside the path.
  output: Schema.Struct({
    appointmentId: appointmentIdSchema.annotate({
      description: "Cancelled appointment ID",
    }),
    status: Schema.String.annotate({ description: "Cancellation status" }),
    reason: Schema.String.annotate({ description: "Cancellation reason" }),
    // `dateField`, so `execute` hands back a `Date` and Rova encodes it to an
    // ISO string before the result is stored. The editor still reads the field
    // as a timestamp, because the annotations sit on the encoded side. See 2.3.
    cancelledAt: dateField("When the cancellation happened"),
  }),
  execute({ payload }) {
    return {
      success: true,
      data: {
        appointmentId: payload.appointmentId,
        status: "cancelled",
        reason: payload.reason,
        cancelledAt: new Date(),
      },
    };
  },
});

const rova = await createRovaApp({
  // Handing the editor over is what turns it on. Development has none to hand
  // over, and Rova then serves the API alone.
  client: isProduction
    ? (await import("@rova/client")).clientBundle
    : undefined,
  // "external" admits every request, so the interface this app binds to is the
  // only thing standing between the editor and whoever else is on the network.
  // A deployment puts a session check here and a gateway in front.
  auth: "external",
  database: { url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL },
  // Rova refuses to start without a 64-character hex key and says so, so there
  // is nothing to check here.
  encryption: { key: process.env.INTEGRATION_ENCRYPTION_KEY },
  migrations: {
    runOnStartup: process.env.RUN_DB_MIGRATIONS === "true",
    migrationsDir: process.env.MIGRATIONS_DIR,
  },
  inngest: {
    id: process.env.INNGEST_APP_ID ?? "notifications-workflow",
    isDev: !isProduction,
    baseUrl: process.env.INNGEST_BASE_URL,
    eventKey: process.env.INNGEST_EVENT_KEY,
    env: process.env.INNGEST_ENV,
    signingKey: process.env.INNGEST_SIGNING_KEY,
    signingKeyFallback: process.env.INNGEST_SIGNING_KEY_FALLBACK,
    serveOrigin: process.env.INNGEST_SERVE_ORIGIN,
    servePath: process.env.INNGEST_SERVE_PATH,
  },
  // The whole extension surface, assembled in one place.
  extensions: {
    integrations: builtInIntegrations,
    events: [
      appointmentCreated,
      appointmentRescheduled,
      appointmentCanceled,
      paymentSettled,
    ],
    actions: [cancelAppointment],
  },
});

// The whole mount is one fetch handler. Bun, Deno and Workers take `rova.fetch`
// as it is; node:http speaks IncomingMessage/ServerResponse, so
// createRequestListener does the one translation step. An Express or Fastify
// host passes the same listener to its own mount call.
const server = createServer(createRequestListener(rova));

const port = Number(process.env.PORT ?? DEFAULT_PORT);

// An unset HOST binds every interface, which is what a container platform
// expects to reach. A platform that wants one interface sets HOST, and this
// repo's dev script sets it to 127.0.0.1, since the app above admits every
// request that arrives.
server.listen(port, process.env.HOST, () => {
  console.log(`Rova listening on http://localhost:${port}/`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      console.log(`Received ${signal}, shutting down`);
      // A keep-alive socket holds `close` open until the browser gives up on it,
      // so ctrl-C would otherwise sit there with the editor open in a tab.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rova.dispose();
      process.exit(0);
    })();
  });
}
```

Three things left this file and are worth noticing. `import "@rova/plugins"` and
`import "@rova/plugins/server"` are gone, because nothing registers on import.
`createTrigger` is gone, because an Event carries the Correlation Path and the builder owns
the lifecycle. And the `triggers` option is gone from `RovaAppOptions`.

### 2.3 How Rova runs an author's schemas

An author may write a schema with a transform and expect the right types on both sides. In
the guide's words, decoding turns unknown external data into typed validated values, and
encoding turns typed values back into a serializable format
(`.repos/effect/packages/effect/SCHEMA.md:7-8`). Rova runs both directions at its seams.

Every claim in this subsection carries a citation to the vendored guide or to
`packages/effect/src/Schema.ts` under `.repos/effect`, and each was also run against
`effect@4.0.0-beta.102`. Verify against those files rather than against memory.

#### The canonical JSON codec is the seam

Encoding through the author's schema is **not** enough, and this is the one thing most
likely to be got wrong. `Schema.Date` is a declaration rather than a codec
(`Schema.ts:11841`), so encoding through the plain schema leaves a live `Date` in the
value. The guide lists the types this applies to: `Date`, `Uint8Array`, `ReadonlyMap`,
`ReadonlySet`, `Symbol`, `BigInt`, custom classes, and Effect data types such as `Option`
(`SCHEMA.md:4773-4778`), with the worked contrast at `SCHEMA.md:3646-3663`.

A live `Date` in a step output is worse than it looks. It survives JSONB and Inngest's own
serialization by accident, because `JSON.stringify` calls `Date.prototype.toJSON`, and it
comes back a `string` on replay. The same memoized step then hands template resolution and
CEL a `Date` on the first attempt and a `string` on the second.

So both directions go through `Schema.toCodecJson`, which is the guide's own pattern for a
JSON boundary (`SCHEMA.md:4763-4952`, and the Elysia integration at `SCHEMA.md:7322-7332`):

```ts
// packages/core/src/backend/lib/steps/define-step.ts
//
// Both sides of a step boundary are JSON, so what Rova runs is the schema's
// canonical JSON codec rather than the schema itself. A `Date`, an `Option`, a
// `Map`, or a class in one of these schemas is JSON only through this.
//
// Built once, at definition: `toCodecJson` walks the AST and builds a new
// schema (SCHEMA.md:4910-4917), so it is startup cost, never per-invocation.
const inputCodec = Schema.toCodecJson(definition.input);
const outputCodec = Schema.toCodecJson(definition.output);

const decodeInput = Schema.decodeUnknownEffect(inputCodec, { errors: "all" });
const encodeOutput = Schema.encodeUnknownEffect(outputCodec, { errors: "all" });
```

`Schema.decodeUnknownEffect` is at `Schema.ts:1471` and `Schema.encodeUnknownEffect` at
`Schema.ts:1940`. `Schema.flip` is the alternative spelling for the encode direction, since
encoding with a schema is decoding with its flipped version (`SCHEMA.md:3462-3514`,
`:5511`).

Three properties make this safe to apply unconditionally, all verified:

- `toCodecJson` is safe to apply to a schema with no transform, but it does not leave every
  such schema alone. It rewrites `optional(X)` to `optionalKey(NullOr(X))`, so an optional
  field accepts an absent key or a null and refuses a key present and holding `undefined`,
  and it gives a bare `Schema.Number` the string spellings of its non-finite values. So
  there is no branch on "does this schema have a transform", and the engine has to write
  no undefined-valued config keys -- which is a change in `core.ts`, made in B3.
- `onExcessProperty: "error"`, which is what `rejectUnknownKeys` holds, still rejects an
  excess key through a `toCodecJson` codec. A step's config decode does not pass those
  options and cannot: the engine hands a step `integrationId`, `_context`, and every other
  key the node holds. `errors: "all"` alone is what it passes.
- The field derivation already agrees with it. `Schema.toJsonSchemaDocument` "first derives
  the schema's canonical JSON codec, then compiles its encoded representation"
  (`SCHEMA.md:6418-6419`). So the paths the editor offers and the bytes Rova writes come
  from the same annotations and describe the same shape by construction
  (`SCHEMA.md:4906`).

#### Every call site

| Call                               | Where                                                           | Options         |
| ---------------------------------- | --------------------------------------------------------------- | --------------- |
| decode a step's or action's input  | `steps/define-step.ts` `runStep`; `extensions/define-action.ts` | `errors: "all"` |
| encode a step's or action's output | the same two, before the `StepResult` envelope                  | `errors: "all"` |
| decode an Event payload, as a gate | `services/workflows/lifecycle/deliver-event.ts`                 | open; see below |

Nowhere else. There is no encode at the JSONB boundary, none in template resolution, and
none in the catalog serializer, because everything reaching those is already encoded.

The input decode is not new behaviour, only newly correct: `define-step.ts:140` already
decodes, and a handler's parameter type has always been the decoded type. What the codec
adds is that an author may now write a transform there and have it work. A step's encoded
input is all strings, because the engine resolves templates into text, so a transform is how
a string becomes the value a handler wants. Twilio's `parseMediaUrls` helper is a
comma-splitting function that belongs in the input schema instead.

#### Encode failure is a step failure

```ts
return (
  yield *
  encodeOutput(data).pipe(
    Effect.mapError(
      (error) =>
        new StepFailure({
          message: `Step "${definition.id}" returned a value its output schema cannot encode: ${formatSchemaFailure(error.issue)}`,
        })
    )
  )
);
```

A handler that returned an unencodable value returns it again on every attempt, so a retry
spends the budget on a certainty. `StepFailure` fails the node once, with a message naming
the field path, in the run log and the step log row. That is the same reasoning
`define-step.ts` already applies in the other direction when it picks `Effect.promise` over
`tryPromise` for the credential fetch.

The path is narrow. A handler's return type is the decoded type, so a mismatch is normally a
compile error, and this is reachable only through an `as`, an `any`, or a widened vendor
type. Narrow and real is the accurate description.

#### An Event payload: the gate is open, and the raw JSON travels

```ts
// packages/core/src/backend/services/workflows/lifecycle/deliver-event.ts
//
// The gate. It validates the fields the Event declares and ignores the rest.
// What the payload decodes to is discarded; what travels is the JSON the sender
// sent.
yield * event.decodePayload(input.payload);
```

**Open, not closed.** Senders evolve and vendors add fields routinely, and an additive
change must not break intake. So the gate validates declared fields and ignores extras. The
raw payload travels either way, so an unknown key is invisible to the pickers rather than an
error. This is a deliberate per-boundary exception: the repo-wide rule that every wire decode
carries `rejectUnknownKeys` stands for the RPC contracts, the graph column, and the Inngest
envelope events. A step's config decode is the other exception, and for a duller reason:
the record the engine builds carries keys that belong to the engine rather than to the step.

The consequence, stated rather than discovered: drift on a **declared** field still fails
loudly, and drift by **addition** is silent by choice. An Event Author who wants a new field
validated declares it.

**The decoded value is deliberately thrown away.** Three reasons, the third decisive.
Nothing downstream of an Event consumes a typed value, because ADR-0007 dissolved the
trigger and its `evaluate`: the lifecycle reads a string at the Correlation Path, CEL match
evaluation reads JSON and `decodeIsoTimestamp` parses ISO at evaluation, template resolution
reads strings, and JSONB holds JSON. It works identically for an Effect schema and a foreign
one, so intake has one path. And re-encoding would rewrite values: verified, a payload
carrying `"2026-03-01T10:00:00Z"` comes back `"2026-03-01T10:00:00.000Z"` after a `Date`
round trip, which would silently break a wait match comparing a literal captured at park
time.

So a transform in an Event schema buys validation precision and derivation, and buys no
typing, because there is no consumer to type. That asymmetry is named here rather than left
for an Event Author to discover. If an event-handler extension point ever exists, it gets
the decoded value and this decision is revisited there.

#### A timestamp, and why `Schema.Date` is refused

A codec's own annotations never reach its JSON Schema:

> When a schema includes a transformation, the generated JSON Schema corresponds to the
> encoded side. Calling `.annotate(...)` on a transformation annotates the decoded side, so
> the annotations won't appear in the JSON Schema output. To annotate the encoded side, use
> `Schema.annotateEncoded`.
> — `SCHEMA.md:5243-5245`

`Schema.annotateEncoded` is the sanctioned one-liner, and the alternative the guide gives
beside it (`SCHEMA.md:5273-5295`) is to annotate the source schema and then `decodeTo`. Both
work. But `annotateEncoded` cannot rescue `Schema.Date`, because a declaration has no
encoding chain to attach to. Verified:

```
Schema.Date.pipe(annotateEncoded({ description, format }))           → { "type": "string" }
Schema.DateFromString.pipe(annotateEncoded({ description, format }))
  → { "type": "string", "description": "when", "format": "date-time" }
```

Neither `Schema.Date` (`Schema.ts:11841`), `Schema.DateFromString` (`:11918`), nor
`Schema.DateTimeUtcFromString` (`:13539`) carries a `format` of its own, because the
unexported `DateString` they build on is a bare annotated string (`:11811`). A `format`
annotation is copied onto the JSON Schema when it is there
(`internal/schema/toJsonSchemaDocument.ts:45-46`), and `normalizeSchemaFormat` in
`schema-codec.ts:256` already maps `date-time` to the `timestamp` field type. So two helpers
in `packages/shared/src/types/timestamp.ts` are the whole mapping:

```ts
/**
 * An ISO 8601 timestamp on the wire and in a handler.
 *
 * Both annotations sit on the base type, before the check, because `.annotate()`
 * on a checked schema lands on the check. The description is a parameter for
 * that same reason.
 */
export function timestampField(description: string) {
  return Schema.String.annotate({ description, format: "date-time" }).check(
    Schema.isPattern(ISO_TIMESTAMP_PATTERN)
  );
}

/**
 * An ISO 8601 timestamp on the wire, a `Date` in a handler.
 *
 * The annotations sit on the encoded side because that is the only side a JSON
 * Schema converter reads. This composition is why the editor can call the field
 * a timestamp while a handler still receives a `Date`.
 */
export function dateField(description: string) {
  return timestampField(description).pipe(
    Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString)
  );
}
```

Verified end to end for a struct using both, `Schema.optional(dateField(...))` included:
the JSON Schema carries `type: "string"` with the description and `format: "date-time"` on
every one; decode gives a real `Date` for `dateField` and a `string` for `timestampField`;
encode gives an ISO string; and `"nope"` is rejected by the pattern. An optional field
renders as `anyOf: [T, null]` (`SCHEMA.md:5330-5366`), so confirm `schema-codec.ts` carries
`format` through that unwrap; optional non-date fields read correctly today, so the unwrap
itself works.

What an author may write:

| Written                                                                      | JSON Schema                              | Handler receives | Verdict                        |
| ---------------------------------------------------------------------------- | ---------------------------------------- | ---------------- | ------------------------------ |
| `timestampField("when")`                                                     | `string`, described, `format: date-time` | `string`         | fine                           |
| `dateField("when")`                                                          | same                                     | `Date`           | fine, the default to reach for |
| `DateFromString.pipe(annotateEncoded({ description, format: "date-time" }))` | same                                     | `Date`           | fine, equivalent               |
| `Schema.Date`                                                                | bare `string`, undescribable             | `Date`           | refused at registration        |
| `Schema.Date.annotate({ description })`                                      | bare `string`                            | `Date`           | refused                        |

`requireOutputFieldsFromSchema` keeps refusing a field with no description, and that refusal
is what pushes an author off `Schema.Date`. Its message gains the codec case, because an
author who annotated a codec and is told the field carries no annotation will read it as a
bug in Rova:

> A codec's own annotations do not reach its JSON Schema (see SCHEMA.md, "Annotating the
> Encoded Side of a Transformation"). Annotate the encoded side with
> `Schema.annotateEncoded`, or use `timestampField` / `dateField`. `Schema.Date` cannot be
> described at all; use `dateField` instead.

`isIsoDatePattern` in `schema-codec.ts` still goes: the keyword route needs no
pattern-sniffing fallback.

#### The Standard Schema bridge validates, and that is all

`Schema.toStandardSchemaV1(schema, { parseOptions })` (`Schema.ts:1240-1307`, wrapped as
`toStandardSchema` in `packages/shared/src/types/schema.ts:158`) attaches a `validate`, and
`~standard` carries `validate` and `jsonSchema` and nothing else
(`SCHEMA.md:6462-6477`). There is no encode through Standard Schema, and the parse options
freeze at the first crossing because Effect returns early when `validate` is already present.

So the bridge stays right for the oRPC contracts, the Inngest envelope events, and the
foreign-schema path, each of which calls `~standard.validate(payload)` with nothing else to
say. It is wrong for the intake gate, which needs Rova's own parse options. `defineEvent`
therefore keeps the original Effect schema and builds its own `decodePayload` (section 3.1),
and `defineStep` needs no bridge at all because its schemas are Effect schemas already.

#### Foreign schemas: the type draws the line

The bridge can validate, so a foreign schema may describe what comes **in**. Only a codec
can encode, so what goes **out** is written in Effect Schema.

- Event payload schemas: Zod and arktype accepted. Only the gate needs them.
- Action config schemas: accepted, for the same reason.
- Action and step output schemas: **Effect only.** `defineAction`'s `output` narrows to
  `Schema.ConstraintDecoder`, matching `defineStep`, which is already Effect-only.

Enforced by the signature. No runtime check, no assembly refusal, and no JSON-safety walk
over the returned value. A foreign output schema stops compiling. The registry tests that use
Zod and arktype as the foreign library stay, pointed at the input paths.

#### The envelope-event exemption

`packages/core/src/backend/lib/inngest/events.ts` keeps the no-transform rule for Rova's
three envelope events, because the Inngest SDK rejects a schema whose input and output types
differ. Said once, here.

---

## 3. The events model

### 3.1 What an event definition is

```ts
// packages/core/src/backend/lib/extensions/define-event.ts

export type EventDefinition<TPayload extends JsonObject> = {
  readonly kind: "event";
  /** The Event's identity in Rova, and by default the name it arrives under. */
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  /** The bridged object, kept for the JSON Schema half and the CEL key extraction. */
  readonly schema: StandardSchema<TPayload>;
  /**
   * The intake gate.
   *
   * Built from the Effect schema with Rova's own parse options when there is
   * one, and from `~standard.validate` when the author wrote the payload in Zod
   * or arktype, so intake has one thing to call and one failure to catch. It
   * validates declared fields and ignores unknown keys (section 2.3), and what
   * it decodes to is discarded: the raw JSON is what travels.
   *
   * It exists because the bridge's parse options freeze at the first crossing,
   * so the options this boundary needs cannot be set on `schema` above.
   */
  readonly decodePayload: (
    payload: unknown
  ) => Effect.Effect<void, PayloadRejected>;
  /**
   * Where this payload carries its Entity Value.
   *
   * Optional, because an imported Event may have no path its author knew to
   * declare, and the Workflow Builder then supplies one in the Lifecycle panel.
   */
  readonly correlationPath?: string;
  /** How the Event arrives, when that differs from its name. */
  readonly source: {
    readonly event: string;
    readonly when?: { readonly path: string; readonly equals: string };
  };
  /** Inngest flow control for this Event's listener function. */
  readonly inngest?: InngestEventOptions;
  /** Derived once, at definition. What the editor lists. */
  readonly payloadFields: readonly ReferenceField[];
  /** Phantom, so the payload type stays inferable at a call site. */
  readonly _payload?: TPayload;
};

export function defineEvent<TPayload extends JsonObject>(input: {
  readonly name: string;
  readonly label?: string;
  readonly description?: string;
  readonly schema: PayloadSchema<TPayload>;
  readonly correlationPath?: EventStringPath<TPayload>;
  readonly source?: {
    readonly event: string;
    readonly when?: {
      readonly path: EventStringPath<TPayload>;
      readonly equals: string;
    };
  };
  readonly inngest?: InngestEventOptions;
}): EventDefinition<TPayload>;
```

`defineEvent` bridges the schema through `asStandardSchema` once, derives `payloadFields`
with `requireOutputFieldsFromSchema`, builds `decodePayload`, and throws when the schema
cannot describe itself. `label` defaults to the name. `source` defaults to
`{ event: name }`.

`PayloadRejected` is one tagged error carrying the sentence a person reads, rendered with
`formatSchemaFailure` on the Effect path and from the joined `issues` on the foreign path.
One type at the seam, so the HTTP route turns it into a 400 and the Inngest listener logs it
and answers non-retryably: a malformed payload does not improve on a second attempt.
`isEffectSchema` in `packages/shared/src/types/schema.ts` is the discriminator that picks
the path.

`EventStringPath<TPayload>` is today's `TriggerStringPath`
(`packages/shared/src/workflow/trigger-registry.ts:134-141`), moved here and renamed. It
admits only paths resolving to a string, which is what an Entity Value is. The check that
used to sit on the trigger now sits beside the schema it walks, one call away instead of
one file away.

`InngestEventOptions` is the flow-control block from today's `CreateTriggerInputEvent`:
`rateLimit`, `throttle`, `debounce`, `priority`, `timeouts`, `retries`. The `event.data.`
path prefixing and the CEL identifier rewriting that `prefixInngestOptions` and
`rewriteCelExpression` already do move with it, tests included. Two members do not come
across. Inngest `concurrency` goes, because per-Entity-Value serialization is now Rova's
Concurrency on the Lifecycle Node, and Inngest's version can neither write a `superseded`
status nor refuse a start. `batchEvents` stays rejected, because it changes the handler
signature.

An Event carries no lifecycle role, no routing, and no classification.

### 3.2 One Event per name, and the umbrella escape hatch

An app declares one Event per thing that happened. Four reasons, strongest first.

**The lifecycle model needs one identity layer.** `CONTEXT.md` says one Event never holds
the start role and the cancel role in the same workflow. With subtypes at a payload path,
an umbrella appointment event holds both roles in the obvious workflow, so the rule would
have to be requalified as "one Event subtype", and every rule mentioning an Event would
inherit the qualification. The Lifecycle Node's lists would hold pairs rather than names.

**Inngest routes on name.** A per-Event listener subscribes to a name and Inngest matches
in its own layer. With subtypes, a workflow that cares about one subtype receives all of
them and discards the rest in Rova code, which is billed invocations for events the
workflow never wanted.

**A sender naturally writes one name per thing that happened.** Inngest's own `EventSchemas`
machinery is keyed on name.

**Payload divergence is the common case.** A cancel carries a reason; a reschedule carries
the previous time. An umbrella shape expresses that only by making every such field
optional, so no consumer can rely on any of them. Separate Events share a schema constant,
which costs one line, and diverge where they genuinely diverge.

For an existing bus that sends one umbrella name and cannot change, `source` separates
identity from transport:

```ts
const appointmentCanceled = defineEvent({
  name: "appointment.canceled", // the Event's identity in Rova
  schema: appointmentPayload,
  correlationPath: "appointment.id",
  source: {
    event: "app/appointment.updated",
    when: { path: "event", equals: "appointment.canceled" },
  },
});
```

Identity stays the Rova name, so the lifecycle model is untouched. `when` compiles into the
listener's per-trigger `if` expression, `event.data.event == 'appointment.canceled'`, so
Inngest still does the filtering and the umbrella adopter pays no extra invocations. This is
the whole of what `eventTypePath` did, in the one place it belongs.

### 3.3 How the registry forms

```ts
// packages/core/src/backend/lib/extensions/extension-set.ts

export type RovaExtensions = {
  readonly events?: readonly EventDefinition<JsonObject>[];
  readonly actions?: readonly ActionDefinition[];
  readonly integrations?: readonly IntegrationDefinition[];
};

export type ExtensionSet = {
  /** The serializable half. This is what /api/extensions sends. */
  readonly catalog: ExtensionCatalog;
  /** Server-only. Keyed by the same ids the catalog uses. */
  readonly stepFor: (actionId: string) => StepImplementation | undefined;
  readonly connectionTestFor: (
    type: string
  ) => IntegrationTestLoader | undefined;
  readonly eventByName: (name: string) => RegisteredEvent | undefined;
  /** Every distinct `source.event`, which is the Inngest listener set. */
  readonly sourceEventNames: readonly string[];
};

export function assembleExtensions(input: RovaExtensions): ExtensionSet;
```

An Event a plugin declares in `defineIntegration({ events })` is registered with it. That
is the only transitive path; with the trigger gone, nothing else brings an Event in.

Five checks run at assembly. Each throws, naming the offender, so the failure lands in the
build and the tests of whoever wrote the definition:

1. Two Events with the same `name` and different schemas. Two references to one definition
   object are fine.
2. Two actions with the same computed id.
3. Two integrations with the same `type`.
4. An output schema `requireOutputFieldsFromSchema` cannot read.
5. An action whose input schema has a required key with no matching config field.

### 3.4 What the browser gets

```ts
// packages/shared/src/extensions/catalog.ts

export type ExtensionCatalog = {
  readonly events: readonly EventMetadata[];
  readonly actions: readonly ActionMetadata[];
  readonly integrations: readonly IntegrationMetadata[];
};

export type EventMetadata = {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  /** Absent when the Event declares none; the builder supplies one. */
  readonly correlationPath?: string;
  readonly payloadFields: readonly ReferenceField[];
};

export type ActionMetadata = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly integration?: string;
  readonly logoUrl?: string;
  readonly configFields: readonly ActionConfigField[];
  readonly outputFields: readonly ReferenceField[];
};

export type IntegrationMetadata = {
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly credentialFields: readonly CredentialFieldMetadata[];
  readonly hasTest: boolean;
};
```

`GET /api/extensions` serves this and is the only channel. There is no `triggers` member,
because there are no triggers. The built-in action types (`Condition`, `Wait`,
`Database Query`, `HTTP Request`) appear in `actions` from `built-ins.ts`, so the browser
holds no action definitions of its own.

Lookups are pure functions over the catalog, in the same shared module, so the server and
the browser run one implementation:

```ts
export function findAction(
  catalog: ExtensionCatalog,
  id: string
): ActionMetadata | undefined;
export function findEvent(
  catalog: ExtensionCatalog,
  name: string
): EventMetadata | undefined;
export function findIntegration(
  catalog: ExtensionCatalog,
  type: string
): IntegrationMetadata | undefined;
export function actionsByCategory(
  catalog: ExtensionCatalog
): Record<string, ActionMetadata[]>;
```

The client holds one decoded catalog in `packages/client/src/lib/extensions.ts`, hydrated
before render the way `hydrateRuntimeExtensionsFromApi` already is
(`packages/client/src/main.tsx:85`). It stays a module value rather than a query-cache
entry: the surface is fixed for the life of the server process, so a cache key nothing
invalidates buys nothing, and pure functions like `getNodeOutputFields(node)` need it
synchronously.

Icons and custom output renderers are React components, so they cannot be serialized.
`@rova/plugins/ui` stays an explicit browser import, keyed by integration type. That is the
one surface where registration by import side effect survives, and section 10 says why it
is the weakest point of this design.

---

## 4. The Lifecycle Node

### 4.1 The rules, as data

```ts
// packages/shared/src/workflow/lifecycle-rules.ts

/**
 * How many Executions may exist per Entity Value.
 *
 * Rova's own, not Inngest's: newest-wins has to end the displaced run with a
 * status, and first-wins has to refuse a start and say so in run history.
 * Inngest concurrency can do neither.
 */
export const concurrencySchema = Schema.Literals([
  "newest-wins",
  "first-wins",
  "unlimited",
]);

export const lifecycleRulesSchema = Schema.Struct({
  /** Event names that start a run. */
  startEvents: Schema.Array(NonEmptyTrimmedString),
  /**
   * Event names that route in-flight runs to the Canceled outlet.
   *
   * Present from the first batch and refused while non-empty until the Canceled
   * outlet lands, so the shape needs no migration when it does.
   */
  cancelEvents: Schema.Array(NonEmptyTrimmedString),
  concurrency: concurrencySchema,

  /** Start sources that are not Events. */
  schedule: Schema.optional(scheduleSchema),
  allowManualStart: Schema.optional(Schema.Boolean),

  /**
   * A Correlation Path the builder supplied for an Event whose definition
   * declares none. Keyed by Event name.
   */
  correlationPaths: Schema.optional(
    Schema.Record(Schema.String, NonEmptyTrimmedString)
  ),
});
```

This replaces `packages/shared/src/workflow/routing-policy.ts` and the whole `triggerType`
plus per-event verb table on the entry node.

### 4.2 What the editor refuses at save

Six rules, each a sentence a builder can be shown:

1. `startEvents` and `cancelEvents` share no member. ADR-0007 rejects the configuration
   rather than picking a winner.
2. Every named Event exists in the catalog. An error names the missing one.
3. Every Cancel Event has a Correlation Path, from its definition or from
   `correlationPaths`. A cancel matches by Entity Value, so a cancel with no path has
   nothing to match on.
4. Every Start Event has a Correlation Path when `concurrency` is not `unlimited`, for the
   same reason. An `unlimited` fire-and-forget workflow may start on a correlation-free
   Event, which is a real case and now expressible.
5. At least one start source exists: a Start Event, a schedule, or manual starts enabled. A
   workflow nothing can start is a mistake worth naming.
6. `cancelEvents` is empty. **Interim rule only**, removed by the stage 7 batch. Its message
   names the reason: "Cancel Events arrive with the Canceled outlet. Until then a workflow
   ends its own runs from the canvas."

Rules 3 and 4 are where the Event Author and the Workflow Builder meet, and the panel should
say which side owns the gap: "This Event declares no Correlation Path. Enter the payload path
holding the value that identifies the entity, or ask whoever defined the Event to declare
it."

### 4.3 Concurrency

- `unlimited`: start. Nothing ends.
- `first-wins`: an in-flight Execution with an equal Entity Value means no new run. The
  arriving Event still reaches that run's Wait Subscriptions, because Precedence says so.
  A new audit event `run_not_started`, reason `concurrency_first_wins`, records the refusal.
  Without that row the behaviour is invisible, which is the class of problem ADR-0007 exists
  to remove.
- `newest-wins`: end each in-flight Execution for that entity with status `superseded`, then
  start. Quiet, and no outlet fires.

Ordering inside `newest-wins` is supersede-then-start, which is what the words mean and what
today's Replace path does. One consequence to state rather than leave a reader to derive: a
superseded run takes no wait delivery because it is ending, and the new run has parked
nothing yet, so a newest-wins start delivers to no waits at all.

### 4.4 Entity Value for a start with no payload

A scheduled start and a manual start carry no payload, so they have no Entity Value.
**Such a start uses the workflow itself as its entity.** That makes `newest-wins` on a cron
workflow mean "a new tick supersedes a tick still running" and `first-wins` mean "skip this
tick while the last one is going". Both are what a builder wants from a scheduled workflow.
Leaving Concurrency inapplicable would make two of its three settings silently do nothing on
the workflows that most need them.

### 4.5 The two outlets

The entry node grows a second source handle, `started` and `canceled`. This is the Condition
node's arrangement, so the graph model needs no new concept:
`serializedWorkflowGraphSchema` already carries `sourceHandle` on an edge
(`packages/shared/src/workflow/schemas.ts:172`), and `workflow-graph.ts:52-58` already
refuses a two-outlet node's edge that names no handle.

One new graph rule, because the Canceled Branch is terminal: no path from inside the
`canceled` branch may reach a node in the `started` branch. `workflow-graph.ts` builds on
graphology-dag, so this is a reachability check over the two handle-rooted subgraphs,
refused at save with the offending edge named. Without it, ADR-0007's rejected
"interruptible lifecycle branches" option creeps back in through a graph a builder happened
to draw.

An unconnected outlet is legal and ends the run.

The second outlet and this rule land in the stage 7 batch, with the rest of the cancel
mechanism. See section 9.

---

## 5. Intake

Everything upstream of the lifecycle collapses to one signature:

```ts
// packages/core/src/backend/services/workflows/lifecycle/deliver-event.ts
export const deliverEvent: (input: {
  readonly eventName: string;
  readonly payload: JsonObject;
}) => Effect.Effect<
  DeliveryOutcome,
  DatabaseError | InngestError,
  RovaServices
>;
```

Two channels reach it, and they differ only in how they learn the name.

### 5.1 Inngest

One listener function per distinct `source.event`, app-wide, built from the catalog. Its
trigger is `{ event: source.event, if?: <compiled when> }` and its options come from
`event.inngest`. The handler reads `event.data` as the payload, resolves which Rova Event
the payload is when several share a source name, and calls `deliverEvent`.

This removes a cost that today's arrangement cannot avoid. The listener set is currently per
workflow, derived from saved graphs, rebuilt from the database behind a 5-second cache, and
needing an Inngest re-sync whenever a workflow's trigger events change
(`packages/core/src/backend/lib/inngest/functions.ts:82-104`, `:141-164`). Under this design
the listener set comes from the catalog, which is fixed when `createRovaApp` runs, so **the
listener set never changes at run time and the re-sync latency disappears.**
`findEventTriggers` and the per-workflow listener functions go, and `getInngestFunctions`
stops reading the database for listeners.

The fan-out moves inside the handler, and wants an index rather than a scan of every graph
per delivered event:

```
workflow_event_subscriptions (workflow_id, event_name, role)
  role: "start" | "cancel" | "wait"
  primary key (workflow_id, event_name, role)
  index on (event_name)
```

Rewritten from the graph on every save, in the same transaction as the graph write, beside
where `invalidateInngestFunctionsCache()` is already called (`services/workflows/workflow.ts:198`,
`:244`, `create.ts:106`, `duplicate.ts:141`, `current.ts:120`). It also answers a question the
editor has wanted: which workflows start on this Event.

The handler loops the subscribing workflows inside `step.run` per workflow, so a failure on
the seventh resumes at the seventh on retry rather than redoing the first six. If the fan-out
outgrows one function, the escape hatch is a per-workflow internal event, and it is not
needed yet.

### 5.2 HTTP

One app-level route, `POST /api/events/:eventName`. It answers 404 when the name is not in
the catalog, calls `deliverEvent`, and turns a `PayloadRejected` from the gate into a 400
carrying the rendered sentence. The gate itself lives in `deliverEvent` (section 6) rather
than in this handler, so both intake channels validate identically. It authenticates with the
API key, the way `postWorkflowResume` does
(`services/workflows/triggering/resume.ts:38-49`, credentials checked before the lookup so a
caller holding a stale name learns nothing).

The per-workflow webhook URL retires. An Event is global, declared in code, and every
workflow subscribing to it should see it; a per-workflow URL means an event posted for one
workflow cannot reach another, which is a statement no part of the model makes. One route
also makes the two channels identical downstream, and lets a sender integrate once instead
of once per workflow.

Reading an event name out of a body by path does not survive. `eventTypePath` sniffing and
`buildWebhookRoutingConfig` are gone from HTTP intake. The sender names the Event in the
path, and an umbrella Inngest bus names it once in `source.when`.

The editor's trigger panel loses its "copy your webhook URL" affordance and gains a per-Event
"copy this Event's URL" affordance beside each Start Event.

---

## 6. Precedence, in code

```ts
// packages/core/src/backend/services/workflows/lifecycle/deliver-event.ts

/**
 * One Event, delivered.
 *
 * The order below is the whole of Precedence (ADR-0007): Lifecycle Rules first,
 * then the Event reaches the Wait Subscriptions of runs that survived them.
 * There is no other ordering rule. A start always starts, and Concurrency
 * resolves multiplicity.
 */
export const deliverEvent = Effect.fn("deliverEvent")(function* (input: {
  eventName: string;
  payload: JsonObject;
}) {
  const event = yield* resolveEvent(input.eventName);

  // The gate: declared fields validated, unknown keys ignored (section 2.3).
  // What it decodes to is discarded, so the raw JSON is what travels on.
  yield* event.decodePayload(input.payload);

  const entityValue = readEntityValue(event, input.payload);

  for (const workflow of yield* subscribedWorkflows(input.eventName)) {
    const settled = yield* applyLifecycleRules({
      workflow,
      event,
      entityValue,
      payload: input.payload,
    });
    yield* deliverToWaits({
      workflow,
      event,
      payload: input.payload,
      excluding: settled.endedExecutionIds,
    });
  }
});

const applyLifecycleRules = Effect.fn(function* (input: LifecycleInput) {
  const rules = input.workflow.lifecycleRules;
  const ended: string[] = [];

  // A Cancel Event routes every in-flight run for this entity to the Canceled
  // outlet. Those runs are ending, so they take no wait delivery below.
  if (rules.cancelEvents.includes(input.event.name)) {
    ended.push(...(yield* requestCanceledOutlet(input)));
  }

  // A start always starts. Concurrency decides what happens to what was already
  // running, and newest-wins ends it quietly.
  if (rules.startEvents.includes(input.event.name)) {
    ended.push(...(yield* startWithConcurrency(input)));
  }

  return { endedExecutionIds: ended };
});
```

Both branches can run for one Event in one workflow only if that Event holds both roles,
which save-time rule 1 refuses.

This replaces the ordered early returns in
`packages/core/src/backend/services/workflows/triggering/orchestrator.ts:162-224`,
`handleCancelOrReplace`, `handleResumes` with its `eventType && correlationKey` guard, and
`orchestrateRoutedTrigger`'s candidate loading in `routing.ts`. The resume-wins-over-start
rule and the policy-wins-over-waits rule were both encoded in that ordering and both retire.
Nothing needs to state them, because nothing can express them: a start is unconditional and
wait delivery happens after, always.

### 6.1 Execution statuses

The column is `"pending" | "running" | "waiting" | "success" | "error" | "cancelled"`
(`packages/core/src/backend/lib/db/schema.ts:67-70`). `CONTEXT.md` fixes the terminal
vocabulary, so it becomes:

```
"pending" | "running" | "waiting" | "completed" | "canceled" | "superseded" | "failed"
```

Three are renames and one of those is a spelling change, `cancelled` to `canceled`, which
`CONTEXT.md` standardizes to one L. The rename reaches the column, `execution-contracts.ts`,
the RPC responses, the run-history components, and a large number of test assertions. Under
the no-backwards-compatibility rule it is a straight rename with no dual reading.

`superseded` is the new member. Run history hides superseded Executions by default, behind a
toggle that shows their count, because a `newest-wins` workflow produces one on every
reschedule and they would otherwise bury the rows a builder came to read.

`trigger_type` on the execution row becomes `start_source: "event" | "schedule" | "manual"`.

### 6.2 The cancel mechanism

This lands in the stage 7 batch. It is specified here so the shape is settled before that
batch opens.

ADR-0007 rules out an Inngest run cancellation, so cancellation is a routed continuation.
Two facts shape the mechanism. A running Execution cannot receive a signal while inside
`step.run`. A parked Execution is not reaching step boundaries at all. So there is one
authority and one nudge.

**The authority is a durable flag.** `requestCanceledOutlet` writes to the execution row:
`cancel_requested_at`, `cancel_event_name`, and `cancel_payload` as JSONB. The engine reads
it inside a step at each node boundary:

```ts
const pending = await runtime.step(`lifecycle-check-${context.nodeId}`, () =>
  store.readPendingCancel(executionId)
);
```

Inside a step, so the answer is memoized. A replay has to see the answer it saw the first
time, or the run takes a different path on a retry and diverges. This is exactly why
ADR-0007 rejects a hard kill: the boundary is deterministic, and every landed node output
stays in the memoized record, which is what makes the Canceled Branch able to read them.

**The nudge wakes a parked run.** The existing envelope carries it: `workflow/wait.signal`'s
`signalType` widens from `Schema.Literal("wait-resume")` to
`Schema.Literals(["wait-resume", "lifecycle-cancel"])`
(`packages/core/src/backend/lib/inngest/events.ts:86-101`). On a `lifecycle-cancel` wake,
`executeEventWait` marks its wait row `cancelled`, treats the payload as no resume payload,
and hands control back to the engine, which reads the flag and enters the `canceled` handle.
The signal carries no decision of its own, so there is one answer to "is this run canceled"
and one place it is written.

**The branch.** The engine enters `canceled` with the run's memoized node outputs intact and
the canceling payload available as the entry node's output. The branch is terminal by the
graph rule in section 4.5. The Execution ends with status `canceled`. An Execution whose
`canceled` outlet has no edge ends immediately with that status and no branch.

---

## 7. The wait model

### 7.1 Two wait modes

The Wait node has two modes and the selector has two rows:

```
How should this step wait?
  Wait for time
  Wait for an event
```

Today there are three. `waitMode: "hook"` ("Wait for webhook event") dies. It was never a
separate mechanism: `"event"` and `"hook"` run the same `prepareHookWait` and
`executeHookWait`, write the same `waitType: "hook"` row, get the same generated resume
token, and suspend on the same envelope with the same four-clause `if` expression. Three
things differed and each is a defect or a field. `"event"` failed outright with no
correlation key (`workflow-engine/core.ts:732-761`), which this design deletes.
`waitTimeoutBehavior: "skip"` was honored for `"event"` only (`core.ts:1218-1222`), so a
webhook-event wait configured to skip silently continued. And `"hook"` exposed
`waitHookToken`, whose fate is section 7.5.

Both modes rendered the same `SharedHookWaitFields`, so both mounted the same
`WaitEventSelect` with the same trigger-derived closed vocabulary and the same implied
correlation match. The Wait bug therefore existed twice, and collapsing removes one copy
instead of fixing it in two places.

### 7.2 The config, as data

```ts
// packages/shared/src/workflow/wait-subscription.ts

/**
 * What a Wait node subscribes to.
 *
 * `event` is an Event name from the catalog, or a name the catalog has never
 * heard of. `match` is the condition model the editor already builds for the
 * Condition node, evaluated against the arriving payload rather than against
 * merged node outputs.
 *
 * Nothing here says how the Event reached Rova. An Inngest send and a post to
 * /api/events/:eventName produce the same subscription check.
 */
export const eventSubscriptionSchema = Schema.Struct({
  event: NonEmptyTrimmedString,
  /** Serialized `ConditionModel`, the same string the Condition node stores. */
  match: Schema.optional(Schema.String),
});

/**
 * The Wait node's config, both modes in one schema.
 *
 * The keys each mode reads are `optional` because the engine resolves templates
 * into every declared config key, so a field the user left blank arrives
 * present and holding `undefined`.
 */
export const waitConfigSchema = Schema.Struct({
  waitMode: Schema.Literals(["delay", "event"]),

  // Event mode.
  waitFor: Schema.optional(
    Schema.Array(eventSubscriptionSchema).check(Schema.isMinLength(1))
  ),
  /**
   * Required, not optional. A wait with no timeout is an immortal Execution: it
   * holds a row, an Inngest function, and a place in the run list until someone
   * notices. The editor defaults it to 7d, which a builder can raise, so the
   * common case costs no thought and no wait outlives its own workflow.
   */
  waitTimeout: Schema.optional(Schema.String),
  waitTimeoutBehavior: Schema.optional(Schema.Literals(["continue", "skip"])),

  // Delay mode, unchanged.
  waitDuration: Schema.optional(Schema.String),
  waitUntil: Schema.optional(Schema.String),
  waitOffset: Schema.optional(Schema.String),
  waitGateMode: Schema.optional(
    Schema.Literals(["off", "require_actual_wait"])
  ),
  waitAllowedHoursMode: Schema.optional(Schema.String),
  waitAllowedStartTime: Schema.optional(Schema.String),
  waitAllowedEndTime: Schema.optional(Schema.String),
  waitTimezone: Schema.optional(Schema.String),
});
```

Every key is `Schema.optional` for the reason the comment gives, so "required" for
`waitTimeout` is enforced by the save-time rule rather than by the key's optionality: an
event-mode Wait node with a blank `waitTimeout` is refused at save, and the editor writes
`7d` when the mode is first chosen. `waitTimeoutBehavior` defaults to `continue`.

`waitMode: "hook"` and `waitHookToken` are gone with no fallback path. A saved node holding
either fails the decode, which is correct under the no-backwards-compatibility rule. This is
also the first schema the Wait node has had; every field was read ad hoc out of the open
config bag before.

`match` reuses `packages/shared/src/workflow/conditions.ts` whole:
`parseConditionModel`, `compileConditionModel`, the per-type operators, and the editor. Its
compiled expressions are rooted at `payload` (`CONDITION_CONTEXT_ROOT`), which is the right
root when the context is one arriving Event payload.

### 7.3 Correlation stays explicit

The stored config always states its own match. When the author adds a subscription and the
workflow's Lifecycle Rules give the run an Entity Value, the editor pre-fills the match with
the arriving payload at that Event's Correlation Path compared against the run's Entity
Value. The runtime has one rule: evaluate the stored predicate. A subscription with no match
resumes on the next occurrence of that Event, and the editor says so in plain words.

That is what makes `CONTEXT.md`'s "two Events describe the same entity when their Entity
Values are equal, even when their Correlation Paths differ" work in the panel. The
`paymentSettled` Event in section 2.2 is the case: `appointmentId` compared against
`appointment.id`.

What the editor writes for a run parked until this appointment's payment settles:

```json
{
  "waitMode": "event",
  "waitFor": [
    {
      "event": "billing/payment.settled",
      "match": "{\"groupLogic\":\"and\",\"groups\":[{\"logic\":\"and\",\"conditions\":[{\"path\":\"appointmentId\",\"type\":\"string\",\"operator\":\"equals\",\"value\":\"{{@lifecycle-1:Start.appointment.id}}\"}]}]}"
    }
  ],
  "waitTimeout": "7d",
  "waitTimeoutBehavior": "skip"
}
```

### 7.4 Park and resume

`prepareHookWait` becomes `prepareEventWait` and `executeHookWait` becomes
`executeEventWait`. Neither takes a mode discriminator, because reaching either one already
means the mode is `event`.

At park time `prepareEventWait` (`workflow-engine/core.ts:1040-1096`) has the template
resolver in hand. For each subscription it resolves the run-side values inside the match to
literals, compiles the model to a CEL string, and writes JSON-safe metadata:

```ts
metadata: {
  waitTimeout: config.waitTimeout,
  waitTimeoutBehavior: config.waitTimeoutBehavior ?? "continue",
  waitFor: [
    { event: "billing/payment.settled",
      expression: 'payload.appointmentId == "appt_8813"' },
  ],
}
```

A compiled string and a literal both survive the JSONB round trip and Inngest's
memoization. `waitMode` leaves the metadata: a row carrying `waitFor` is an event wait and a
row without one is a timer.

The row's `waitType` becomes `"delay" | "event"`, so one word means one thing across the
config, the row, and the audit messages. The `waitModeLabel` ternaries (`core.ts:1112`,
`:1153`) go with it. The row gains `subscribed_events text[]` with a GIN index, so candidates
are found by Event name.

`resumeMatchingWaitHooks` becomes: load candidates with a new
`listWorkflowWaitsForEvent({ workflowId, eventName, runMode })`, then for each evaluate its
stored expression against the arriving payload with
`evaluateCelBooleanExpression({ expression, context: { payload } })`
(`packages/core/src/backend/lib/cel/environment.ts:202`), and on true send the signal.
`waitMatchesEvent` and the string comparison it wraps are deleted, and so is the
correlation-key requirement in the candidate query.

Two behaviours are fixed rather than preserved. The correlation-key failure at
`core.ts:732-761` is deleted, because the match is the matcher. The `waitMode === "event"`
guard on the timeout skip at `core.ts:1218-1222` is deleted, so a wait's timeout behavior is
whatever its config says.

### 7.5 The resume token

`POST /workflows/hooks/:token/resume` survives as a resume path and stops being a wait mode.
It already works against any wait: every event wait gets a generated `hookToken`, because
Inngest's `ifExpression` matches on it, and `postWorkflowResume` looks a wait up by that
token with no event-type and no correlation check
(`packages/core/src/backend/api-app.ts:487-513`,
`services/workflows/triggering/resume.ts`). It stays because a run parked on an Event that
will never arrive has to be unparkable.

`waitHookToken`, the explicit design-time token, is deleted. Three reasons. It is broken for
concurrency: a fixed token is decided at design time, `workflow_wait_states_hook_token_uidx`
is unique, and two runs parked at the same node either collide on insert or leave one row
unfindable, so a single POST resumes an arbitrary one. Its purpose is served properly now,
because an external system sends an Event and the wait's match decides whether it belongs to
this run. And the legitimate operator case is a read rather than a write: the runs panel
gains a Resume affordance on a waiting node, which reads the token off the wait row and posts
to the endpoint.

Optional and separable: "hook" is now stale in the `hook_token` column, the
`workflow_wait_states_hook_token_uidx` index, and the endpoint path. Renaming them to
`resume_token` and `POST /workflows/waits/:token/resume` is one migration and about eight
call sites. Recommended while the migration is open, and droppable without affecting anything
else.

### 7.6 Independence from the lifecycle

A Wait Subscription names an Event with no reference to any lifecycle role, which is what
`CONTEXT.md` requires. The `cancellingSelections` warning at `wait-event-select.tsx:219-230`
dies with the policy that made it true, and nothing replaces it: under the fixed order, a
Cancel Event routing a run to the Canceled outlet is what the builder configured on the
Lifecycle Node and can read there.

---

## 8. The type-level contract

What convention held before and the compiler holds now.

**An action has an implementation.** `handler` or `load` is a required field of `defineStep`,
and `defineStep` is the only way to build an action. An action with no step is not
constructible. Before, `packages/plugins/src/server.ts` was a separate file and nothing
checked that it covered the declared actions.

**Ids agree.** The action id is `${integration.type}/${slug}`, computed from the integration's
`type` and the record key. The id exists in one place. Before it was written three times and
`registerStep`'s `NoInfer` checked two of them.

**Config fields name real config keys.** `configFields[].key` is
`Extract<keyof TInput, string>`, so a field the step cannot read fails to compile. Assembly
check 5 adds the coverage half.

**Credentials keys are the plugin's own.** `CredentialsOf<typeof fields>` is
`Partial<Record<Fields[number]["envVar"], string>>`, which needs the fields as a tuple of
literals; `credentialFields()` is a `const`-type-parameter identity function that provides
that. A handler reading `credentials.TWILIO_ACCOUNT_SI` fails to compile. Six hand-written
`credentials.ts` files go away.

**A Correlation Path is checked against the payload it indexes.**
`EventStringPath<TPayload>` admits only paths resolving to a string.

**The `IntegrationType` union dies.** It exists because a global map is keyed by a closed
union and `isIntegrationType` guards untrusted strings. The set of integration types is now
the app's `integrations` array, and the closed set is a runtime `Set` built at assembly.
`RovaAppOptions.plugins` goes with it: disabling an integration means not passing it.

**The import list becomes value exports.** `packages/plugins/src/index.ts` exports each
integration by name plus `builtInIntegrations`. A plugin the barrel forgets is a compile
error at the app that names it. The barrel is side-effect free, so a host importing
`{ twilio }` alone has the other five tree-shaken out.

**The Wait node has a schema,** so the engine stops narrowing `"hook" | "event"` by hand in
two places and stops reading six fields out of an open bag with ad-hoc string checks.

**What comes in may be foreign; what goes out is a codec.** An Event payload schema and an
action config schema may be written in Zod or arktype, because validating is all the Standard
Schema bridge can do. A step's or action's output schema is `Schema.ConstraintDecoder`, so it
is an Effect schema, because only a codec can encode. The signature is the whole enforcement:
a foreign output schema stops compiling, with no runtime check and no JSON-safety walk over
the returned value. Section 2.3 has the reasoning.

What the compiler stops proving: Start Events and Cancel Events are Event names in
builder-authored JSONB, so there is no trigger-to-event agreement left to type. The six
save-time rules in section 4.2 replace it. That is the correct trade, because the pairing is
a builder decision and a builder decision cannot be a compile error.

What is still unproven: a Wait node's Event name and a saved node's action id, both user data
in a JSONB column, validated where they are saved and where the editor renders them. And a
renamed action slug silently repoints saved nodes at a missing action, which is true today
too and which this design does not improve.

---

## 9. File layout, and what dies

### 9.1 New

```
packages/shared/src/extensions/
  catalog.ts            ExtensionCatalog, the metadata types, the pure lookups
  catalog-wire.ts       the Effect Schema the browser decodes the catalog with
packages/shared/src/workflow/
  lifecycle-rules.ts    lifecycleRulesSchema, concurrencySchema, the save rules
  wait-subscription.ts  eventSubscriptionSchema, waitConfigSchema

packages/core/src/backend/lib/extensions/
  define-event.ts       defineEvent, EventDefinition, EventStringPath, eventFromInngest
  define-action.ts      defineAction (today's createAction, renamed and moved)
  define-integration.ts defineIntegration, credentialFields, CredentialsOf
  extension-set.ts      assembleExtensions and its five checks
  built-ins.ts          Condition, Wait, Database Query, HTTP Request as catalog entries
  current.ts            configureExtensions / getExtensions, deleted in the stage 7 batch

packages/core/src/backend/services/workflows/lifecycle/
  deliver-event.ts      deliverEvent, applyLifecycleRules
  concurrency.ts        startWithConcurrency
  cancel.ts             requestCanceledOutlet (stage 7 batch)
  subscriptions.ts      the workflow_event_subscriptions read and rewrite

packages/client/src/lib/
  extensions.ts         the decoded catalog and its accessors
```

`defineStep` keeps its home at `packages/core/src/backend/lib/steps/define-step.ts` for what
it already owns: the config decode, the credential fetch, the run log rows, and the
`StepResult` envelope. It loses its `id` and gains the metadata an action needs, so a step
and an action become one value. The Promise seam inside it is untouched and belongs to stage 7.

### 9.2 Deleted

Plugins:

- `packages/plugins/src/server.ts`, and the `./server` export from its manifest.
- `packages/plugins/src/*/credentials.ts`, six files.
- `packages/plugins/src/*/schemas.ts`, six files, folded into each `index.ts`. Their reason
  for existing was that the browser imported the metadata half.

Shared:

- The registry half of `packages/shared/src/plugins/registry.ts`: `registerIntegration`,
  `unregisterIntegration`, `getIntegration`, `getAllIntegrations`, `getIntegrationTypes`,
  `getAllActions`, `getActionsByCategory`, `findActionById`, `getIntegrationLabels`,
  `getIntegrationDescriptions`, `getSortedIntegrationTypes`, both `Symbol.for` maps, and
  `actionByIdCache` with its version comparison. The module keeps the field types,
  `isFieldGroup`, `flattenConfigFields`, and `getCredentialMapping`.
- `packages/shared/src/workflow/trigger-registry.ts`, entirely. `TriggerStringPath`,
  `prefixInngestOptions`, `prefixConcurrency`, `rewriteCelExpression`, and
  `collectCelIdentifiers` move to `define-event.ts` with their tests.
- The registry half of `packages/shared/src/workflow/action-registry.ts`: the `Symbol.for`
  state, `registerRuntimeAction`, `unregisterRuntimeAction`, `getRuntimeAction`,
  `getRuntimeActions`, `clearRuntimeActions`, `listRuntimeActions`,
  `getRuntimeActionRegistryVersion`.
- `packages/shared/src/workflow/routing-policy.ts`.
- `packages/shared/src/workflow/triggers/` whole: `fallback-trigger.ts`,
  `schedule-trigger.ts`, `webhook-trigger.ts`.
- `packages/shared/src/workflow/webhook-routing.ts`.
- `packages/shared/src/workflow/wait-events.ts`.
- `packages/shared/src/types/integration.ts`: `IntegrationType`, `INTEGRATION_TYPE_MAP`,
  `isIntegrationType`.
- `isIsoDatePattern` in `packages/shared/src/workflow/schema-codec.ts`.
- The `Symbol.for` map in `packages/shared/src/plugins/ui-registry.ts` becomes a plain module
  map, since one bundle holds it.

Core:

- `packages/core/src/backend/lib/step-registry.ts`: `STEP_LOADERS`, `registerStep`,
  `registerBuiltInStep`, `getStepImporter`, `getActionLabel`, `SYSTEM_ACTION_LABELS`.
- `packages/core/src/backend/services/integrations/integration-test-loaders.ts`.
- `packages/core/src/backend/lib/workflow-trigger-bootstrap.ts`.
- `packages/core/src/backend/services/workflows/triggering/orchestrator.ts` and `routing.ts`,
  including `toPlainLogger` (which was stage 7 item 4 and dies here instead).
  `preflight.ts` and `run-lifecycle.ts` survive; `startWorkflowRun` is what
  `startWithConcurrency` calls.
- `packages/core/src/backend/services/workflows/triggering/webhook.ts`, replaced by the
  `/api/events/:eventName` handler.
- The per-workflow shape of `packages/core/src/backend/lib/inngest/event-listener-function.ts`,
  replaced by a per-Event listener. `findEventTriggers` goes.
- `RovaAppOptions.triggers`, `RovaAppOptions.plugins`, `PluginConfig`,
  `RuntimeExtensionTriggerDefinition`, `RuntimeExtensionActionDefinition`.
- `triggerType` on the entry node config; `trigger_type` on the execution row becomes
  `start_source`.

Client:

- `packages/client/src/components/workflow/config/routing-policy-editor.tsx`.
- `packages/client/src/components/workflow/config/trigger-vocabulary.ts`.
- `packages/client/src/components/workflow/config/webhook-schema.ts`.
- `HookWaitFields` and `SharedHookWaitFields` in `action-config.tsx`.
- `DEFAULT_TRIGGER_OUTPUT_FIELDS` in `packages/client/src/lib/upstream-node-fields.ts`.
- `trigger-config.tsx` is rewritten rather than deleted: the same panel slot renders the
  Lifecycle Rules.

### 9.3 The two bugs, closed by construction

**The Wait node could only offer its trigger's events.** Three restrictions stacked and one
thing was missing. The missing thing was the registry: event names lived only inside
`createTrigger`. Section 3 creates it, and `catalog.events` is what the picker reads, so the
picker cannot be per-trigger because triggers do not exist. Section 5 makes any Event
deliverable, because the listener set is the catalog rather than a per-workflow graph walk.
Section 7 replaces the implied correlation match with a stored predicate, so the
correlation-key requirement and the candidate query's correlation filter both go. The picker
keeps free entry for a name the catalog has never heard of, which is still deliverable and
simply offers no field list.

**Trigger payload fields were dropped by the picker.** Three fixes.

The synthetic defaults go. `DEFAULT_TRIGGER_OUTPUT_FIELDS` is deleted, and
`workflow-engine/core.ts:1625-1642` stops writing `{ triggered: true, timestamp: Date.now() }`
over the payload. The entry node's output is the payload. `triggered` says nothing a node that
ran does not already say, `input` resolved to nothing, and `timestamp` was already being
overwritten by any payload carrying that key while the picker labelled it "Trigger timestamp"
and typed it `timestamp` in both cases.

A timestamp becomes declarable. `timestampField` and `dateField` land in
`packages/shared/src/types/timestamp.ts`, beside the codec that already owns which strings
count. Section 2.3 has both bodies, the reason the annotations have to sit on the encoded
side, and the table of what an author may write. In short: `timestampField` gives a string on
both sides, `dateField` gives a string on the wire and a `Date` in a handler, and
`Schema.Date` is refused at registration because it cannot be described at all.

Both are exported from `@rova/core` for hosts and `@rova/core/plugin` for plugin authors,
because `@rova/shared` is private. The pattern-prefix heuristic `isIsoDatePattern` is
deleted, since the `format` keyword route needs no fallback. `requireOutputFieldsFromSchema`
gains the codec-aware refusal message from section 2.3.

One deliberate consequence: a payload declaring a timestamp field and carrying `"tomorrow"`
fails its Event schema and is refused at intake. That is drift on a declared field, which
stays loud; an undeclared field a sender adds is ignored instead.

The picker ranks rather than filters. `isFieldCompatible`
(`packages/client/src/components/ui/template-autocomplete.tsx:28-48`) puts compatible fields
first and keeps the rest, because a template renders to a string and
`parseTimestampWithTimezone` accepts an ISO string or a unix epoch. The three duration fields
(`action-config.tsx:483`, `:517`, `:649`) stop rendering an empty menu. The placeholder at
`action-config.tsx:502` is rewritten to the real token grammar, `{{@nodeId:Label.path}}`.

### 9.4 Entry-node fields come from the branch

The entry node offers different fields depending on which outlet a node sits behind. Walk
back from the node to the outlet the way Condition branches are already walked
(`packages/shared/src/workflow/condition-branch.ts`,
`packages/core/src/backend/lib/workflow-graph.ts:52-58`):

- Reachable from `started` only: the payload fields of the Start Events.
- Reachable from `canceled` only: the payload fields of the Cancel Events.
- Reachable from both: the intersection of those two sets.

Within each set, several Events mean the intersection of their payload fields, because a
field only some of them carry would resolve to nothing on the runs that lack it.

The walk-back lands with the rest of the picker work. Until the Canceled outlet exists every
node is `started`-reachable, so the walk returns the Start Events' fields and the branch logic
is correct but unexercised.

---

## 10. The batch plan

Each batch lands green on `main` before the next starts. `pnpm run type-check`,
`pnpm run lint`, `pnpm test`, `pnpm run build`, `pnpm run knip`, and `pnpm run fix` all pass.
Delete `tsconfig.tsbuildinfo` before type-checking; stale incremental state has hidden real
errors.

**Task #16 first.** The database-options reshape (`database.migrations`, `database.schema`,
the discrete-credentials union arm) runs before any migration-bearing batch below, so
migrations regenerate once. B2, B6, and B7 each carry migrations.

### B1. The catalog and events. No migration. Gate.

`packages/shared/src/extensions/catalog.ts` with its types and pure lookups, the wire schema,
`defineEvent` complete, `assembleExtensions` as a skeleton fed by the existing registries,
`/api/extensions` serving the catalog, and the client reading it. The old registries stay live
and keep registering. Nothing else changes. This batch alone gives the browser one channel and
gives every later batch its registry.

**Landed, with two follow-ups.** The first is done: `describeSchema` in
`packages/shared/src/workflow/output-fields.ts` called `jsonSchema.output()` first, which is
the decoded side (`Schema.ts:1338-1352` shows `output` calls `toType(self)`). For a transform
that is the wrong side, and the failure was quiet: a decoded side with no JSON form emits `{}`
for that property, the field reader drops it, and because the drop is nested it slipped past
the root-level count check in `findDerivationProblem`. Fixed in `bed99f5`, reading `input()`
only, with a regression test deriving a `decodeTo` codec field from the encoded side.

The second follow-up is open: `defineEvent` gains `decodePayload` (section 3.1) and stops
relying on the bridge for validation, whose parse options freeze at the first crossing. B2
needs it, and the interface note is the only point of contact.

### B2. Events replace triggers, and the Lifecycle Node. Migration. Two gates.

Per-Event Inngest listeners; the `/api/events/:eventName` route; `lifecycleRulesSchema` with
its six save rules; the Lifecycle panel with Start Events, Concurrency, schedule, and manual
starts; the Cancel Events section present, disabled, and carrying rule 6's message;
`deliverEvent` and `applyLifecycleRules` with the start and concurrency arms;
`workflow_event_subscriptions`; the status rename plus `superseded` and its run-history
default-hidden toggle; `start_source`; `examples/app.ts` on four Events; the trigger, routing
policy, webhook-routing, and built-in-trigger deletions.

**Mid-batch gate** after `lifecycleRulesSchema`, `deliverEvent`, and the concurrency arms
exist and are unit-tested, before any UI work. That is where a reviewer can still change the
shape cheaply. **End gate** on the whole batch.

This is the largest batch and it does not split cleanly. A split that lands the panel first
would leave one commit where a builder configures rules nothing reads, which passes every
check and ships a broken editor. The mid-batch gate is the answer instead.

**One deviation from 4.2, taken in phase 2.** Rule 5 counts a schedule as a start source, and
the shape carried a `schedule` member for the panel to write into. Neither survived: nothing in
Rova ticks a clock, so a schedule could only ever be written and refused, and a shape whose one
writer is a save refusal is a shape with no writer. `lifecycleRules` therefore has no `schedule`
member, `hasStartSource` counts Start Events and manual starts, and the panel shows a schedule
placeholder saying where a timed run comes from instead. Whichever batch brings the clock adds
the member back with the code that reads it.

### B3. `defineIntegration`, piloted on twilio. No migration. Gate.

The definition shape, `defineStep` gaining metadata and losing its id, twilio ported, and
`assembleExtensions` reading both the new definitions and the old registries for exactly this
one commit. That dual path is the pattern stage 6a used and it exists for one commit only.
Independent of B2, so it can run in parallel under a different reviewer.

The codec work from section 2.3 lands here: one `Schema.toCodecJson` per schema, built at
definition, feeding a `decodeUnknownEffect` on the way in and an `encodeUnknownEffect` on the
way out, with encode failure mapped to a `StepFailure`. `defineAction`'s `output` narrows to
`Schema.ConstraintDecoder`. Twilio is where a transform first earns its place: its
`parseMediaUrls` helper becomes a comma-splitting transform on the input schema.

### B4. The integration sweep. No migration. Gate.

The five remaining plugins, then every deletion in section 9.2 under Plugins and the registry
halves under Shared and Core. `packages/plugins/src/AGENTS.md` is rewritten here, and its
quick-start checklist of four files to touch becomes one file to write. The README gains a
section per definition function, in the order an outside author meets them: an Event, an
action, an integration.

### B5. Entry-node fields and timestamps. No migration. Gate.

`timestampField` and `dateField`; the codec-aware refusal message in
`requireOutputFieldsFromSchema`; the `isIsoDatePattern` deletion; the synthetic-field and
engine-key deletions; the branch-derived entry-node fields from section 9.4; the ranking
picker; the placeholder fix.

One thing to verify rather than assume, because section 2.3 could not settle it by reading:
`Schema.optional(dateField(...))` renders as `anyOf: [{ type: "string", format: "date-time",
… }, { type: "null" }]`, so confirm `schema-codec.ts` carries `format` through that unwrap.
Optional non-date fields read correctly today, so the unwrap itself works; whether it copies
`format` off the member is what needs a test.

### B6. Wait subscriptions and the mode collapse. Migration. Gate.

`wait-subscription.ts` with the required timeout and the 7-day editor default; the park and
resume changes; `subscribed_events` and `listWorkflowWaitsForEvent`; wait delivery inside
`deliverEvent`; the picker and match editor; the mode collapse; the runs-panel Resume
affordance; optionally the `hook_token` to `resume_token` rename. Splittable if review wants
it: the shared schema and the engine can land ahead of the intake and the editor.

### B7. Stage 7, with the Canceled outlet. Migration. Gate.

Stage 7 as ADR-0002 scopes it: kill the `globalThis`-backed `db` proxy and `getDb`, kill the
module-level Inngest client, remove the Promise seam inside `defineStep`, own the Inngest
function registry's module cache, and decide the two built-in steps. The `ExtensionSet`
becomes `ExtensionRegistryLayer` and `extensions/current.ts` goes.

The Canceled outlet lands here, and this is why: stage 7 rewrites the node-boundary structure
that the boundary read rides on, so building the read against today's structure would mean
building it twice. In this batch it arrives as part of the interior it belongs to. The pieces
are the second source handle on the entry node, the terminal-branch graph rule, the
`cancel_requested_at` plus `cancel_event_name` plus `cancel_payload` columns, the boundary
read inside a step, the `lifecycle-cancel` `signalType` member and its handling in
`executeEventWait`, the `canceled` status semantics, `requestCanceledOutlet`, and the removal
of save rule 6 so the Lifecycle panel accepts Cancel Events. Section 9.4's branch walk becomes
exercised here.

On completion: verify `pnpm pack` on `@rova/core`, confirm no surviving `globalThis` state,
and mark ADR-0002's sequencing section done.

### Interim behaviour, stated plainly

Between B2 and B7 a workflow can start runs, supersede them under `newest-wins`, refuse them
under `first-wins`, and wake waits. It cannot cancel runs from an Event. A builder who needs
that ends runs from the canvas or the runs panel, which is what the existing manual
cancellation path already does. The Lifecycle panel says so where a builder will look.

---

## 11. Honest costs

**Icons keep an import side effect.** A React component cannot be serialized, so
`@rova/plugins/ui` stays an explicit browser import keyed by integration type. A host-defined
integration cannot ship an icon component unless the host writes its own ui module and imports
it. This is the weakest point of the design. It removes registration-by-import everywhere the
data is data and leaves it exactly where the value is a component. `logoUrl` is the escape
hatch for a host that only wants an image.

**The JSON-safety enforcement point moves, and does not move everywhere.** It was a runtime
walk over any step output, `findNonJsonSafeValue`, which issue #12 exists to retire. Encoding
through the canonical JSON codec (section 2.3) replaces it for every schema-described output,
and by construction rather than by inspection. It does not replace it for `Database Query` and
`HTTP Request`, which are Promise functions with no output schema, so the walk stays until
stage 7 item 5 gives them one. Close #12 against schema-described outputs and say in the issue
what is left. For one release there are two mechanisms, and the reason is written down rather
than left to be rediscovered.

**A `Date` in a step output was a near-miss worth recording.** An earlier draft of this design
encoded through the author's output schema rather than through its JSON codec. That leaves a
live `Date` in the value, which survives JSONB and Inngest by accident through
`Date.prototype.toJSON` and comes back a `string` on replay. A value whose type differs
between the first attempt and the replay of the same memoized step is the worst failure mode
this engine has. It was caught by reading the Effect guide, not by a test, so the plan owes one:
a replay assertion on a `Date`-bearing output, in `core-replay.test.ts`.

**A new runtime failure: a handler returns a value its output schema cannot encode.** It
surfaces as a `StepFailure`, so the node fails once with a message naming the field path, in
the run log and the step log row. Reachable only through an `as`, an `any`, or a widened vendor
type, because the handler's return type is the decoded type.

**`Schema.Date` is a trap with a good error message.** An author reaching for the obvious name
gets a registration refusal, because a declaration cannot carry a description or a `format`
and nothing can make it describable. The refusal message carries the reason and the two
working spellings, and that is the whole mitigation.

**An Event payload decoding open means additive drift is silent.** A sender that adds a field
is ignored rather than refused, which is the point. The cost is that a field an Event Author
meant to rely on but forgot to declare will never be validated and will never appear in a
picker, and nothing says so. Drift on a declared field still fails loudly.

**Two decode paths hide behind one `decodePayload`,** one Effect and one foreign. The
complexity is real and it is in one place.

**Foreign output schemas stop compiling** for host actions, so an adopter with a Zod output
schema converts it. The blast radius in this repo is nil, because `examples/app.ts` writes
Effect already.

**One-file plugins need the vendor SDK behind a dynamic import.** Clerk, linear, and acuity
keep an SDK, and with the handler inline, importing `builtInIntegrations` would pull all three
into the process at startup. Section 2.1 shows the `Effect.cached` pattern that avoids it, and
`AGENTS.md` has to teach it. Skipping it costs startup weight and supply-chain surface for
every adopter, whether or not they use those three.

**The client test suite moves.** Every client test rendering a component that reads plugin
metadata currently relies on `import "@rova/plugins"` having populated a global registry. Each
needs a seeded catalog instead. A `stubExtensionCatalog({ actions: [...] })` factory beside
the existing `backend/lib/effect/test-layers.ts` factories makes it one line per test, but the
count of touched files is high. This is the largest migration risk in the design and it lands
in B1 and B4.

**A missing `integrations` line fails quietly.** A host who forgets `builtInIntegrations` gets
an editor with no integrations and no error. `createRovaApp` logs the assembled counts at
startup, and the action selector says the surface is empty rather than rendering nothing.

**B2 is the largest single batch** and has no clean seam, because the extension surface and
the lifecycle model land together. The mid-batch gate is the mitigation rather than a fake
split.

**The status rename is wide and mechanical.** `success` to `completed`, `error` to `failed`,
`cancelled` to `canceled`. The one-L spelling change is the kind a search-and-replace
half-finishes.

**Derived state can drift.** `workflow_event_subscriptions` is rewritten on every save, and a
stale row makes a workflow receive an Event it no longer names or miss one it does. The
mitigations are writing it in the same transaction as the graph and making the fan-out
re-read the rules and skip a workflow whose rules no longer name the Event. A periodic
reconciliation is available if drift is ever observed.

**Retiring the per-workflow webhook URL is a product change.** A sender integrated against a
workflow-specific URL has to move to `/api/events/:eventName`. There is no dual path.

**Deleting the synthetic entry-node fields breaks graphs quietly.** A workflow in a dev
database referencing `{{Trigger.timestamp}}` or `{{Trigger.triggered}}` resolves to nothing
after B5. The no-backwards-compatibility rule licenses it, and "quietly" is the accurate word.

**A node configured `waitMode: "hook"` fails its config decode after B6** rather than
degrading, so a dev workflow holding one needs an editing pass. Deleting `waitHookToken`
removes a capability with no like-for-like replacement; it was incorrect for more than one
concurrent run, and the two paths that replace it each cover a different half of what it was
reached for.

**Requiring a wait timeout changes what a builder can express.** A genuinely unbounded wait is
no longer writable. The 7-day default keeps the common case thoughtless, and a builder who
wants a year types one.

**Several Start Events make the entry node's fields an intersection.** A run started on
`appointment.created` carries no `reason`; one started on `appointment.canceled` does, so only
the intersection can be offered safely. The branch-derived walk narrows this where the
outlets differ and does not remove it where several Events share an outlet. This is the
strongest argument the umbrella-event model had, and the sharp edge is visible in the picker
where a second identity layer would have been invisible in the model.

**Wait delivery costs a query per delivered Event,** one indexed lookup and N CEL evaluations
per workflow subscribing to that Event.

**The cancel flag adds a read at every node boundary,** one indexed primary-key read and one
memoized step entry per node per run. On a wide graph that is a real increase in step count.
Checking less often would make "at the next step boundary" untrue. Measure it on a wide graph
before B7 closes.

---

## 12. Every test file the plan touches

Deleted, because the module under test goes:

- `packages/shared/src/workflow/trigger-registry.test.ts`
- `packages/shared/src/workflow/routing-policy.test.ts`
- `packages/shared/src/workflow/wait-events.test.ts`
- `packages/shared/src/workflow/webhook-routing.test.ts`
- `packages/shared/src/workflow/triggers/webhook-trigger.test.ts`
- `packages/core/src/backend/lib/step-registry.test.ts`
- `packages/core/src/backend/services/workflows/triggering/orchestrator.test.ts`
- `packages/core/src/backend/services/workflows/triggering/webhook.test.ts`
- `packages/client/src/components/workflow/config/routing-policy-editor.test.tsx`
- `packages/client/src/components/workflow/config/webhook-schema.test.ts`
- `packages/plugins/src/twilio/schemas.test.ts`

New:

- `packages/shared/src/extensions/catalog.test.ts`
- `packages/shared/src/workflow/lifecycle-rules.test.ts`
- `packages/shared/src/workflow/wait-subscription.test.ts`
- `packages/shared/src/workflow/output-fields.test.ts` (landed in `bed99f5`: derivation reads
  the encoded side, so a `decodeTo` codec field survives)
- `packages/core/src/backend/lib/extensions/define-event.test.ts` (absorbs the path-typing,
  CEL-rewriting, and Inngest-option cases from `trigger-registry.test.ts`, and adds
  `decodePayload`: a declared field validated, an unknown key ignored, a foreign schema taking
  the same path)
- `packages/core/src/backend/lib/extensions/define-integration.test.ts`
- `packages/core/src/backend/lib/extensions/extension-set.test.ts` (the five assembly checks)
- `packages/core/src/backend/services/workflows/lifecycle/deliver-event.test.ts` (Precedence)
- `packages/core/src/backend/services/workflows/lifecycle/concurrency.test.ts`
- `packages/core/src/backend/services/workflows/lifecycle/cancel.test.ts` (B7)
- `packages/client/src/lib/extensions.test.ts`
- `packages/client/src/components/workflow/config/lifecycle-rules-editor.test.tsx`

Rewritten, because the contract changes:

- `packages/shared/src/workflow/action-registry.test.ts` becomes the `defineAction` test.
  Keep its Zod and arktype fixtures: they are the foreign Standard Schema libraries the
  bridge claims to accept.
- `packages/shared/src/workflow/standard-schema-compat.test.ts`, same reason, retargeted at
  `asStandardSchema` in its new callers.
- `packages/core/src/backend/lib/workflow-engine/core-replay.test.ts`: the status rename, plus
  the assertion the near-miss in section 11 owes. A node whose output schema holds a
  `dateField` keeps the same type across a replay, because the value crossed the boundary
  encoded.
- `packages/shared/src/workflow/schema-codec.test.ts`: the `format: "date-time"` route in,
  `isIsoDatePattern` out.
- `packages/shared/src/types/timestamp.test.ts`: `timestampField` and `dateField` cases,
  including that `dateField` decodes to a `Date`, encodes to an ISO string, and keeps its
  description and `format` on the encoded side under `Schema.optional`.
- `packages/shared/src/workflow/schemas.test.ts`: the entry node's config and the second
  `sourceHandle`.
- `packages/shared/src/workflow/node-references.test.ts`: entry-node field derivation.
- `packages/core/src/backend/lib/steps/define-step.test.ts`: the action-shaped `defineStep`,
  plus the codec cases from section 2.3. A transform on the input reaching the handler as its
  decoded type; a `Date` in the output leaving as an ISO string; and a handler that lies to the
  compiler failing as a `StepFailure` naming the field path.
- `packages/core/src/backend/lib/inngest/functions.test.ts`: per-Event listeners, and the
  removal of the per-workflow graph walk.
- `packages/core/src/backend/lib/inngest/event-listener-function.test.ts`: the per-Event
  handler and the fan-out.
- `packages/core/src/backend/lib/workflow-wait-resume.test.ts`: the stored-expression match
  replaces the string comparison. Its cases at 303-390 assert today's contract and tighten.
- `packages/core/src/backend/lib/workflow-engine/core-wait.test.ts`: the two-mode config, the
  required timeout, and the deletion of the correlation-key failure at 218-233.
- `packages/core/src/backend/lib/workflow-graph.test.ts`: the two-outlet entry node and the
  terminal-branch rule.
- `packages/core/src/app.test.ts`: `extensions` replaces `triggers`, `actions`, and `plugins`.
- `packages/client/src/lib/upstream-node-fields.test.ts`: its cases at 319-325 assert
  `triggered`, `timestamp`, and `input` are present, which asserts the bug. Tighten to the
  payload fields, then add the branch-derived cases.
- `packages/client/src/components/workflow/config/wait-event-select.test.tsx`: the catalog-fed
  picker, no closed vocabulary, no cancelling-selections warning.
- `packages/client/src/components/workflow/config/trigger-config.test.tsx`: becomes the
  Lifecycle panel's test.
- `packages/plugins/src/{acuity,clerk,linear,resend,slack,twilio}/index.test.ts`: six files,
  each asserting the new definition shape instead of registration side effects.

Touched for a status rename or a registry seam, otherwise unchanged in intent:

- `packages/core/src/backend/services/workflows/bulk-lifecycle.test.ts`
- `packages/core/src/backend/services/workflows/duplicate.test.ts`
- `packages/core/src/backend/services/workflows/executions/global.test.ts`
- `packages/core/src/backend/services/workflows/mappers.test.ts`
- `packages/core/src/backend/services/workflows/triggering/run-lifecycle.test.ts`
- `packages/core/src/backend/services/workflows/triggering/resume.test.ts`
- `packages/core/src/backend/lib/workflow-cancellation.test.ts`
- `packages/core/src/backend/lib/workflow-action-validation.test.ts`
- `packages/core/src/backend/lib/workflow-integration-validation.test.ts`
- `packages/core/src/backend/lib/workflow-conditions-validation.test.ts`
- `packages/core/src/backend/lib/workflow-engine/core.test.ts`
- `packages/core/src/backend/lib/workflow-engine/core-branching.test.ts`
- `packages/core/src/backend/lib/inngest/workflow-function.test.ts`
- `packages/core/src/backend/services/integrations/integrations.test.ts`
- `packages/core/src/backend/services/integrations/integration-config-masking.test.ts`
- `packages/client/src/lib/node-integration.test.ts`
- `packages/client/src/lib/workflow-graph-store.test.ts`
- `packages/client/src/lib/workflow-save-store.test.ts`
- `packages/client/src/components/workflow/workflow-run-summary-row.test.tsx`
- `packages/client/src/components/flow-elements/edge.test.tsx`
- `packages/client/src/components/ui/template-badge-autocomplete.test.tsx`

Unchanged, listed so nobody goes looking: `packages/plugins/src/*/steps/*.test.ts` and the
vendor client tests keep testing a handler as a function of `(input, context)` to an
`Effect`, which this design does not alter. `vendor-http.test.ts`, the `cel/environment.test.ts`
suite, the `http/` suites, the rpc suites, `telemetry.test.ts`, `effects.test.tsx`,
`schema-builder.test.tsx`, `use-node-config-writer.test.tsx`, `workflow-layout.test.ts`,
`controls.test.tsx`, `bundle.test.ts`, `node.test.ts`, `base-path.test.ts`,
`query-client.test.ts`, `rpc-client.test.ts`, `rpc-query.test.ts`, `utils.test.ts`,
`schedule-expression.test.ts`, `wait-time.test.ts`, `action-config-validation.test.ts`,
`schema-validation.test.ts`, `conditions.test.ts`, `condition-branch.test.ts`,
`error-message.test.ts`, `auth.test.ts`, `internal-failure.test.ts`,
`inngest-client.test.ts`, and `http-request.test.ts` all stand.

Baseline before this work: 872 tests across 97 files.
