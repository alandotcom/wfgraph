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
 * The custom trigger and action are the interesting half. They show what
 * `createTrigger` and `createAction` are for, and Rova serves them beside its
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
import { createAction, createTrigger } from "@rova/core";
import { createRovaApp } from "@rova/core/app";
import { createRequestListener } from "@rova/core/node";
// The built-in integrations, turned on by importing them: metadata the editor
// renders, then the step implementations and connection tests.
import "@rova/plugins";
import "@rova/plugins/server";
import { Schema } from "effect";

const APPOINTMENT_TRIGGER_TYPE = "AppointmentLifecycle";
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

const appointmentSchema = Schema.Struct({
  id: appointmentIdSchema,
  startsAt: Schema.String,
  patientName: Schema.String,
  status: Schema.String,
});

// When `event` is set, workflows using this trigger listen for the named
// Inngest event instead of requiring webhook HTTP calls. Send events from
// your app with:
//
//   inngest.send({
//     name: "app/appointment.updated",
//     data: { event: "appointment.created", timestamp: "...", appointment: { ... } },
//   });
//
// README's Embedding section documents the rest of the options an event
// trigger takes, under "Notes".
//
// The trigger supplies vocabulary only: the schema, the correlation path,
// and the event type path. What each event type does to a run (Start,
// Replace, Cancel, Ignore) is the workflow's Routing Policy, configured per
// workflow in the editor's trigger panel.
const appointmentTrigger = createTrigger({
  type: APPOINTMENT_TRIGGER_TYPE,
  label: "Appointment Lifecycle",
  event: "app/appointment.updated",
  concurrency: { limit: 1, key: "appointment.id" },
  description:
    "Classifies appointment.created, appointment.rescheduled, and appointment.canceled events for the routing policy.",
  schema: Schema.Struct({
    event: Schema.Literals([
      "appointment.created",
      "appointment.rescheduled",
      "appointment.canceled",
    ]),
    timestamp: Schema.String,
    appointment: appointmentSchema,
  }),
  correlationIdPath: "appointment.id",
  eventTypePath: "event",
});

const cancelAppointmentAction = createAction({
  id: "appointments/cancel",
  label: "Cancel Appointment",
  description: "Cancels an appointment and records the cancellation reason.",
  category: "Appointments",
  outputFields: [
    { path: "appointmentId", description: "Cancelled appointment ID" },
    { path: "status", description: "Cancellation status" },
    { path: "cancelledAt", description: "ISO timestamp of cancellation" },
  ],
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
    url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  },
  // Rova refuses to start without a 64-character hex key and says so, so there
  // is nothing to check here.
  encryption: {
    key: process.env.INTEGRATION_ENCRYPTION_KEY,
  },
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
  actions: [cancelAppointmentAction],
  triggers: [appointmentTrigger],
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
