/**
 * The Workflow Graph app this repo runs, for `pnpm run dev` and for `pnpm run start`.
 *
 * The repo has no server of its own. `createWfGraphApp` returns a fetch handler and
 * the host mounts it, so the only server here is an adopter's app, written the
 * way an adopter writes one. Running it is what keeps the published path
 * exercised: every line below is a line someone embedding Workflow Graph would also write,
 * and anything that would exist only to serve this repo's dev loop belongs
 * somewhere else.
 *
 * The Events and the custom action are the interesting half. They show what
 * `defineEvent` and `defineAction` are for, and Workflow Graph serves them beside its
 * built-in integrations with no further registration.
 *
 * Development hands over no editor. `pnpm run dev` runs Vite's dev server in
 * packages/client, which compiles the SPA and proxies `/api` here, so there is
 * no built bundle to pass. Production has one, and passing it is what turns the
 * editor on.
 */

import { createServer } from "node:http";
import {
  createRequestListener,
  createWfGraphApp,
  defineAction,
  defineEvent,
} from "@wfgraph/core";
import { configureWfGraphLogging } from "@wfgraph/core/logging";
import { wfPostgres } from "@wfgraph/core/postgres";
// The built-in integrations, as values. Nothing registers on import, so the line
// that passes them to `createWfGraphApp` below is what turns them on and dropping it
// is what turns them off.
import { builtInIntegrations } from "@wfgraph/plugins";
import { z } from "zod";

// Workflow Graph asks LogTape for a logger and configures nothing, so where its
// records go is this app's decision. One call installs the console setup it
// ships: `LOG_LEVEL` picks the level, `LOG_FORMAT` picks pretty or JSON, and an
// attached terminal picks pretty when neither is set. An app with its own
// LogTape configuration drops this line and adds a sink for the "wfgraph"
// category instead.
configureWfGraphLogging();

const DEFAULT_PORT = 4017;
const DEFAULT_DATABASE_URL =
  "postgresql://workflow:workflow@localhost:55437/workflow_builder";

const isProduction = process.env.NODE_ENV === "production";

// Workflow Graph reads a schema through Standard Schema and asks nothing else of it. The
// editor labels a path from its key ("Patient Name" from `patientName`), and
// `z.iso.datetime()` emits `format: "date-time"`, which is what gives the field
// before/after operators in the condition builder and admits it to the Wait
// node's date field. A `.describe()` replaces the derived label, so it earns its
// place only where the key reads badly alone.
const appointmentIdSchema = z.string().describe("Appointment ID");

const appointmentSchema = z.object({
  id: appointmentIdSchema,
  startsAt: z.iso.datetime(),
  patientName: z.string(),
  status: z.string(),
});

/**
 * The Events this app raises: a name, a payload shape, and where the payload
 * carries its Entity Value. An Event holds no lifecycle role -- which workflow
 * starts on it, and which cancels on it, is each Workflow Builder's decision in
 * the editor (ADR-0007).
 *
 * Send one from your app:
 *
 *   inngest.send({ name: "app/appointment.created", data: { appointment, occurredAt } });
 */
const occurredAt = z.iso.datetime();

const appointmentCreated = defineEvent({
  name: "app/appointment.created",
  label: "Appointment created",
  description: "Raised when a new appointment is booked.",
  schema: z.object({ appointment: appointmentSchema, occurredAt }),
  correlationPath: "appointment.id",
});

const appointmentRescheduled = defineEvent({
  name: "app/appointment.rescheduled",
  label: "Appointment rescheduled",
  description: "Raised when an appointment moves to a new time.",
  schema: z.object({
    appointment: appointmentSchema,
    occurredAt,
    previousStartsAt: z.iso.datetime(),
  }),
  correlationPath: "appointment.id",
});

const appointmentCanceled = defineEvent({
  name: "app/appointment.canceled",
  label: "Appointment canceled",
  description: "Raised when an appointment is called off.",
  schema: z.object({
    appointment: appointmentSchema,
    occurredAt,
    reason: z.string().describe("Why it was canceled"),
  }),
  correlationPath: "appointment.id",
});

/**
 * An Event no workflow starts on.
 *
 * This app's billing service already sends it. Declaring it makes it available
 * to a Wait node, so a run started by an appointment Event and parked after
 * "send the invoice" resumes when the payment settles. An Event needs no
 * lifecycle role to wake a wait.
 *
 * Which parked run an arrival wakes is the Wait node's own match, written in the
 * editor: `appointmentId` here against the run's `appointment.id`. The Correlation
 * Path below is what the match editor offers first, and what Concurrency would
 * compare if a workflow ever started on this Event.
 */
const paymentSettled = defineEvent({
  name: "billing/payment.settled",
  label: "Payment settled",
  description: "Raised by the billing service when a charge clears.",
  schema: z.object({
    appointmentId: appointmentIdSchema,
    amountCents: z.number().describe("Amount settled, in cents"),
    settledAt: z.iso.datetime(),
  }),
  correlationPath: "appointmentId",
});

const cancelAppointmentAction = defineAction({
  id: "appointments/cancel",
  label: "Cancel Appointment",
  description: "Cancels an appointment and records the cancellation reason.",
  category: "Appointments",
  input: z.object({
    appointmentId: appointmentIdSchema,
    reason: z.string().min(1),
  }),
  // What the action returns. The editor derives its template picker from this,
  // so a downstream node addresses exactly the fields the handler answers with.
  output: z.object({
    appointmentId: appointmentIdSchema,
    status: z.string(),
    reason: z.string(),
    cancelledAt: z.iso.datetime(),
  }),
  // The cancellation goes inside `step.run`, so a retry of a later node replays
  // this answer rather than cancelling a second time. Workflow Graph wraps no handler body:
  // work with a side effect says so here or it happens again on every attempt.
  handler({ input, step }) {
    return step.run("cancel", () =>
      Promise.resolve({
        appointmentId: input.appointmentId,
        status: "cancelled",
        reason: input.reason,
        cancelledAt: new Date().toISOString(),
      })
    );
  },
});

const wfgraph = await createWfGraphApp({
  // Handing the editor over is what turns it on. Development has none to hand
  // over, and Workflow Graph then serves the API alone.
  client: isProduction
    ? (await import("@wfgraph/client")).clientBundle
    : undefined,
  // "external" admits every request, so the interface this app binds to is the
  // only thing standing between the editor and whoever else is on the network.
  // See the listen call below. A deployment puts a session check here and a
  // gateway in front.
  auth: "external",
  persistence: wfPostgres({
    // One URL, or the discrete host/port/user/password/database fields a
    // platform hands out separately.
    url: process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL,
    // Workflow Graph keeps its tables in "_workflows" unless told otherwise. This is read
    // here because `pnpm run db:migrate` reads the same variable, and an app
    // querying one schema while the migrator creates another is a bad afternoon.
    schema: process.env.DATABASE_SCHEMA?.trim() || undefined,
    migrations: {
      runOnStartup: process.env.RUN_DB_MIGRATIONS === "true",
      migrationsDir: process.env.MIGRATIONS_DIR,
    },
  }),
  // Workflow Graph refuses to start without a 64-character hex key and says so, so there
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
    // Long-running Node dials out over Connect so Inngest can push executions
    // here without reaching this process over HTTP. Serverless hosts leave this
    // unset and keep `/api/inngest` for Inngest to call back.
    connect: true,
    instanceId: process.env.INNGEST_INSTANCE_ID,
    gatewayUrl: process.env.INNGEST_CONNECT_GATEWAY_URL,
  },
  // The whole extension surface, assembled in one place. The Events are what the
  // editor lists and what the per-Event Inngest listeners are built from.
  extensions: {
    integrations: builtInIntegrations,
    events: [
      appointmentCreated,
      appointmentRescheduled,
      appointmentCanceled,
      paymentSettled,
    ],
    actions: [cancelAppointmentAction],
  },
});

// The whole mount is one fetch handler. Bun, Deno and Workers take `wfgraph.fetch`
// as it is; node:http speaks IncomingMessage/ServerResponse, so
// createRequestListener does the one translation step. An Express or Fastify
// host passes the same listener to its own mount call.
const server = createServer(createRequestListener(wfgraph));

const port = Number(process.env.PORT ?? DEFAULT_PORT);

// An unset HOST binds every interface, which is what a container platform
// expects to reach. A platform that wants one interface sets HOST, and this
// repo's dev script sets it to 127.0.0.1, since the app above admits every
// request that arrives.
server.listen(port, process.env.HOST, () => {
  console.log(`Workflow Graph listening on http://localhost:${port}/`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      console.log(`Received ${signal}, shutting down`);
      // A keep-alive socket holds `close` open until the browser gives up on it,
      // so ctrl-C would otherwise sit there with the editor open in a tab.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await wfgraph.dispose();
      process.exit(0);
    })();
  });
}
