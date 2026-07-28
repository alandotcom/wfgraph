import { createServer } from "node:http";
import { createAction, createTrigger } from "@rova/core";
import { clientBundle } from "@rova/client";
import { createRovaApp } from "@rova/core/app";
import { createRequestListener } from "@rova/core/node";
import { config as loadDotEnv } from "dotenv";
import postgres from "postgres";
import { z } from "zod";

const APPOINTMENT_TRIGGER_TYPE = "AppointmentLifecycle";
// One above the dev server's defaults on every dial, so the example runs while
// `pnpm run dev` is up: its port, its Inngest dev server, and its database are
// all its own.
const DEFAULT_PORT = 4018;
const DEFAULT_INNGEST_BASE_URL = "http://localhost:8389";
const DEFAULT_DATABASE_URL =
  "postgresql://workflow:workflow@localhost:55437/workflow_builder_example";
const appointmentSchema = z.object({
  id: z.string(),
  startsAt: z.string(),
  patientName: z.string(),
  status: z.string(),
});

function loadEnvironmentFiles(): void {
  loadDotEnv({ path: ".env" });
  loadDotEnv({ path: ".env.local" });
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

// The dev server's database is shaped by `pnpm run db:push`, which records no
// migration journal, so this example's startup migrator would replay the first
// migration into it and fail on schemas that already exist. The example keeps a
// sibling database in the same Postgres container and creates it here on first
// run. The two admin queries go through postgres.js, which is the driver
// @rova/core already talks to Postgres with.
async function ensureDatabaseExists(databaseUrl: string): Promise<void> {
  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.slice(1)
  );

  // CREATE DATABASE has to run from a different database on the same server;
  // `postgres` is the maintenance database every installation has.
  const maintenanceUrl = new URL(databaseUrl);
  maintenanceUrl.pathname = "/postgres";

  const admin = postgres(maintenanceUrl.toString(), { max: 1 });
  try {
    const existing =
      await admin`SELECT 1 FROM pg_database WHERE datname = ${databaseName}`;
    if (existing.length === 0) {
      await admin.unsafe(
        `CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`
      );
      console.log("[example] created database", databaseName);
    }
  } finally {
    await admin.end();
  }
}

// When `event` is set, workflows using this trigger listen for the named
// Inngest event instead of requiring webhook HTTP calls. Send events from
// your app with:
//
//   inngest.send({
//     name: "app/appointment.updated",
//     data: { event: "appointment.created", timestamp: "...", appointment: { ... } },
//   });
//
// Event triggers support Inngest function options:
//   concurrency  — limit concurrent executions; `key` is schema-relative (auto-prefixed with `event.data.`)
//   inngest      — rateLimit, throttle, debounce, priority, timeouts, retries
//                  `key` fields are schema-relative (auto-prefixed with `event.data.`)
//                  `priority.run` accepts schema-relative CEL expressions (identifiers rewritten to `event.data.`)
//
// Multi-event example:
//   event: ["app/appointment.created", "app/appointment.updated"],
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
  schema: z.object({
    event: z.enum([
      "appointment.created",
      "appointment.rescheduled",
      "appointment.canceled",
    ]),
    timestamp: z.string(),
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
  schema: z.object({
    appointmentId: appointmentSchema.shape.id.describe("Appointment ID"),
    reason: z.string().trim().min(1).describe("Cancellation reason"),
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

async function main(): Promise<void> {
  loadEnvironmentFiles();

  const databaseUrl =
    asNonEmptyString(process.env.DATABASE_URL) ?? DEFAULT_DATABASE_URL;
  await ensureDatabaseExists(databaseUrl);

  const portRaw = asNonEmptyString(process.env.PORT);
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${portRaw}`);
  }

  const inngestBaseUrl =
    asNonEmptyString(process.env.INNGEST_BASE_URL) ??
    asNonEmptyString(process.env.INNGEST_DEV) ??
    DEFAULT_INNGEST_BASE_URL;
  const signingKey = asNonEmptyString(process.env.INNGEST_SIGNING_KEY);

  const encryptionKey = asNonEmptyString(
    process.env.INTEGRATION_ENCRYPTION_KEY
  );
  if (!encryptionKey) {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY is required (64-character hex string). Rova stores integration credentials encrypted with it."
    );
  }

  const rova = await createRovaApp({
    // Handing the editor over is what turns it on; without this the example
    // serves an API and answers 404 at the root.
    client: clientBundle,
    // An example on localhost. A real host passes a predicate that reads
    // whatever session its own users already carry.
    auth: "external",
    configureLogging: false,
    logger: {
      info: (...args) => console.log("[example:server]", ...args),
      warn: (...args) => console.warn("[example:server]", ...args),
      error: (...args) => console.error("[example:server]", ...args),
    },
    database: {
      url: databaseUrl,
    },
    encryption: {
      key: encryptionKey,
    },
    migrations: {
      runOnStartup: true,
    },
    inngest: {
      id: "appointment-configurable-server-example",
      isDev: process.env.NODE_ENV !== "production",
      baseUrl: inngestBaseUrl,
      eventKey: asNonEmptyString(process.env.INNGEST_EVENT_KEY),
      env: asNonEmptyString(process.env.INNGEST_ENV),
      signingKey,
    },
    actions: [cancelAppointmentAction],
    triggers: [appointmentTrigger],
  });

  // The whole mount is one fetch handler. Bun, Deno and Workers take it as-is;
  // node:http speaks IncomingMessage/ServerResponse, so createRequestListener
  // from @rova/core/node does the one translation step. Express and Fastify
  // hosts pass the same listener to their own mount call.
  const httpServer = createServer(createRequestListener(rova));

  httpServer.listen(port, () => {
    console.log("[example] configurable server started", {
      url: `http://localhost:${port}/`,
      triggerType: APPOINTMENT_TRIGGER_TYPE,
      actionId: "appointments/cancel",
      note: "Use the built-in frontend as usual. Create a workflow with trigger Appointment Lifecycle and add the Cancel Appointment action.",
    });
  });
}

main().catch((error) => {
  console.error("[example] failed to start", error);
  process.exit(1);
});
