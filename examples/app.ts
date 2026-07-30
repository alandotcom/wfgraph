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
 * `defineEvent` and `createAction` are for, and Rova serves them beside its
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
import { createAction, defineEvent } from "@rova/core";
import { createRovaApp } from "@rova/core/app";
import { createRequestListener } from "@rova/core/node";
// The built-in integrations, turned on by importing them: metadata the editor
// renders, then the step implementations and connection tests.
import "@rova/plugins";
import "@rova/plugins/server";
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

// Every field is annotated, nested ones included: the editor lists
// `AppointmentLifecycle.appointment.startsAt` as its own entry in the template
// picker and shows this text beside it, so a field left bare reads as the word
// "string" to whoever is building the workflow.
const appointmentSchema = Schema.Struct({
  id: appointmentIdSchema,
  startsAt: Schema.String.annotate({
    description: "When the appointment starts, ISO 8601",
  }),
  patientName: Schema.String.annotate({ description: "Patient name" }),
  status: Schema.String.annotate({ description: "Appointment status" }),
}).annotate({ description: "The appointment this event is about" });

/**
 * The Events this app raises: a name, a payload shape, and where the payload
 * carries its Entity Value. An Event holds no lifecycle role -- which workflow
 * starts on it, and which cancels on it, is each Workflow Builder's decision in
 * the editor (ADR-0007).
 *
 * Send one from your app:
 *
 *   inngest.send({ name: "app/appointment.created", data: { appointment, occurredAt } });
 *
 * Or post it, which needs no Inngest client:
 *
 *   POST /api/events/app%2Fappointment.created
 */
const occurredAt = Schema.String.annotate({
  description: "When the event was raised, ISO 8601",
});

const appointmentCreated = defineEvent({
  name: "app/appointment.created",
  label: "Appointment created",
  description: "Raised when a new appointment is booked.",
  schema: Schema.Struct({ appointment: appointmentSchema, occurredAt }),
  correlationPath: "appointment.id",
});

const appointmentRescheduled = defineEvent({
  name: "app/appointment.rescheduled",
  label: "Appointment rescheduled",
  description: "Raised when an appointment moves to a new time.",
  schema: Schema.Struct({
    appointment: appointmentSchema,
    occurredAt,
    previousStartsAt: Schema.String.annotate({
      description: "The time it was moved from, ISO 8601",
    }),
  }),
  correlationPath: "appointment.id",
});

const appointmentCanceled = defineEvent({
  name: "app/appointment.canceled",
  label: "Appointment canceled",
  description: "Raised when an appointment is called off.",
  schema: Schema.Struct({
    appointment: appointmentSchema,
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
    settledAt: Schema.String.annotate({
      description: "When the payment settled, ISO 8601",
    }),
  }),
  correlationPath: "appointmentId",
});

const cancelAppointmentAction = createAction({
  id: "appointments/cancel",
  label: "Cancel Appointment",
  description: "Cancels an appointment and records the cancellation reason.",
  category: "Appointments",
  // What the action returns, described the same way its input is. The editor's
  // template picker is derived from this, so the list that used to be written
  // out beside it -- and had already fallen a field behind what `execute`
  // answers with -- is gone. Every field is annotated for the same reason the
  // input's are: the annotation is what an operator reads beside the path.
  outputSchema: Schema.Struct({
    appointmentId: appointmentIdSchema.annotate({
      description: "Cancelled appointment ID",
    }),
    status: Schema.String.annotate({ description: "Cancellation status" }),
    reason: Schema.String.annotate({ description: "Cancellation reason" }),
    cancelledAt: Schema.String.annotate({
      description: "ISO timestamp of cancellation",
    }),
  }),
  schema: Schema.Struct({
    appointmentId: appointmentIdSchema,
    reason: Schema.String.annotate({
      description: "Cancellation reason",
    }).check(Schema.isMinLength(1)),
  }),
  execute({ payload }) {
    return {
      success: true,
      data: {
        appointmentId: payload.appointmentId,
        status: "cancelled",
        reason: payload.reason,
        cancelledAt: new Date().toISOString(),
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
  // See the listen call below. A deployment puts a session check here and a
  // gateway in front.
  auth: "external",
  database: {
    // One URL, or the discrete host/port/user/password/database fields a
    // platform hands out separately.
    url: process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL,
    // Rova keeps its tables in "_workflows" unless told otherwise. This is read
    // here because `pnpm run db:migrate` reads the same variable, and an app
    // querying one schema while the migrator creates another is a bad afternoon.
    schema: process.env.DATABASE_SCHEMA?.trim() || undefined,
    migrations: {
      runOnStartup: process.env.RUN_DB_MIGRATIONS === "true",
      migrationsDir: process.env.MIGRATIONS_DIR,
    },
  },
  // Rova refuses to start without a 64-character hex key and says so, so there
  // is nothing to check here.
  encryption: {
    key: process.env.INTEGRATION_ENCRYPTION_KEY,
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
  actions: [cancelAppointmentAction],
  // The Events this app declares, which is what the editor lists and what the
  // per-Event Inngest listeners are built from.
  extensions: {
    events: [
      appointmentCreated,
      appointmentRescheduled,
      appointmentCanceled,
      paymentSettled,
    ],
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
