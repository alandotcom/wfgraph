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
 * no built bundle to pass. Vite owns development page navigation, so this
 * harness gates the API requests Vite proxies; production document navigation
 * remains owned by the host handler below.
 */

import { createServer } from "node:http";
import {
  createRequestListener,
  createWfGraphApp,
  defineAction,
  defineEvent,
} from "@wfgraph/core";
import { configureWfGraphLogging } from "@wfgraph/core/logging";
import { wfSqlite } from "@wfgraph/core/sqlite";
// The built-in integrations, created for this app. Nothing registers on import, so
// the line that passes them to `createWfGraphApp` below is what turns them on and
// dropping it is what turns them off.
import { builtInIntegrations } from "@wfgraph/plugins";
import { z } from "zod";
import { createDemoAuth } from "./demo-auth";

// Workflow Graph asks LogTape for a logger and configures nothing, so where its
// records go is this app's decision. One call installs the console setup it
// ships: `LOG_LEVEL` picks the level, `LOG_FORMAT` picks pretty or JSON, and an
// attached terminal picks pretty when neither is set. An app with its own
// LogTape configuration drops this line and adds a sink for the "wfgraph"
// category instead.
configureWfGraphLogging();

const DEFAULT_PORT = 4017;

const isProduction = process.env.NODE_ENV === "production";
const publicUrl =
  process.env.WFGRAPH_PUBLIC_URL?.trim() ||
  (isProduction
    ? undefined
    : `http://localhost:${process.env.PORT ?? DEFAULT_PORT}`);

const demoAuth = createDemoAuth({
  isProduction,
  ...(publicUrl ? { publicUrl } : {}),
});

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
  // OAuth providers compare callback URLs exactly. Development uses the local
  // server origin; deployments set WFGRAPH_PUBLIC_URL to their external origin.
  ...(publicUrl ? { publicUrl } : {}),
  // Handing the editor over is what turns it on. Development has none to hand
  // over, and Workflow Graph then serves the API alone.
  client: isProduction
    ? (await import("@wfgraph/client")).clientBundle
    : undefined,
  // This demonstration authenticates the in-memory principal from the session
  // cookie, then authorizes each operation against its selected role preset.
  auth: demoAuth.auth,
  // SQLite creates its schema the first time the app opens the file, so there
  // is no migration step and no separate service. The name carries no
  // directory, which puts the file beside this one and keeps the app from
  // having to create a directory before it can start. Omitting `filename`
  // gives an in-memory database instead, which no other process can read.
  persistence: wfSqlite({
    filename: process.env.SQLITE_PATH?.trim() || "wfgraph.sqlite",
  }),
  // Workflow Graph refuses to start without a 64-character hex key and says so, so there
  // is nothing to check here.
  encryption: {
    key: process.env.INTEGRATION_ENCRYPTION_KEY,
  },
  // The build agent is off without a key, and the editor then shows no chat
  // panel, so an adopter who wants no AI in their editor writes nothing here.
  agent: {
    apiKey: process.env.OPENAI_API_KEY,
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
    // Slack's OAuth flow turns on when the host hands over a Slack app's client
    // credentials; with neither variable set, the editor offers the bot-token
    // form alone.
    integrations: builtInIntegrations({
      slack: {
        oauthClient: {
          clientId: process.env.SLACK_CLIENT_ID,
          clientSecret: process.env.SLACK_CLIENT_SECRET,
        },
      },
    }),
    events: [
      appointmentCreated,
      appointmentRescheduled,
      appointmentCanceled,
      paymentSettled,
    ],
    actions: [cancelAppointmentAction],
  },
});

// The host routes login and logout before handing every other request to the
// Workflow Graph fetch handler. createRequestListener performs the node:http
// IncomingMessage/ServerResponse translation for this combined Web handler.
const server = createServer(
  createRequestListener({
    ...wfgraph,
    fetch: demoAuth.createFetch(wfgraph.fetch),
  })
);

const port = Number(process.env.PORT ?? DEFAULT_PORT);

// The example binds loopback by default in every mode. Set HOST explicitly when
// a deployment needs to accept connections from another interface.
const host = process.env.HOST?.trim() || "127.0.0.1";
const hostForUrl =
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
server.listen(port, host, () => {
  console.log(`Workflow Graph listening on http://${hostForUrl}:${port}/`);
  if (!isProduction) {
    console.log(
      "Dev login: open http://localhost:5173/login in the Vite browser tab (use Vite's printed port if 5173 is busy)"
    );
  }
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
