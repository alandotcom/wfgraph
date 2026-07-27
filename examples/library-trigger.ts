import { createAction, createTrigger } from "@rova/core";
import { createRovaApp } from "@rova/core/app";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

const APPOINTMENT_TRIGGER_TYPE = "AppointmentLifecycle";
const DEFAULT_PORT = 4017;
const DEFAULT_INNGEST_BASE_URL = "http://localhost:8388";
const DEFAULT_DATABASE_URL =
  "postgresql://workflow:workflow@localhost:55437/workflow_builder";
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
const appointmentTrigger = createTrigger({
  type: APPOINTMENT_TRIGGER_TYPE,
  label: "Appointment Lifecycle",
  event: "app/appointment.updated",
  concurrency: { limit: 1, key: "appointment.id" },
  description:
    "Routes appointment.created/start, appointment.rescheduled/restart, and appointment.canceled/stop.",
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
  lifecycle: {
    onStart: ({ payload }) => payload.event === "appointment.created",
    onRestart: ({ payload }) => payload.event === "appointment.rescheduled",
    onStop: ({ payload }) => payload.event === "appointment.canceled",
  },
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
    asNonEmptyString(Bun.env.DATABASE_URL) ?? DEFAULT_DATABASE_URL;

  const portRaw = asNonEmptyString(Bun.env.PORT);
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${portRaw}`);
  }

  const inngestBaseUrl =
    asNonEmptyString(Bun.env.INNGEST_BASE_URL) ??
    asNonEmptyString(Bun.env.INNGEST_DEV) ??
    DEFAULT_INNGEST_BASE_URL;
  const signingKey = asNonEmptyString(Bun.env.INNGEST_SIGNING_KEY);

  const encryptionKey = asNonEmptyString(Bun.env.INTEGRATION_ENCRYPTION_KEY);
  if (!encryptionKey) {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY is required (64-character hex string). Rova stores integration credentials encrypted with it."
    );
  }

  const rova = await createRovaApp({
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
      client: {
        id: "appointment-configurable-server-example",
        isDev: Bun.env.NODE_ENV !== "production",
        baseUrl: inngestBaseUrl,
        eventKey: asNonEmptyString(Bun.env.INNGEST_EVENT_KEY),
        env: asNonEmptyString(Bun.env.INNGEST_ENV),
      },
      serve: signingKey ? { signingKey } : undefined,
    },
    actions: [cancelAppointmentAction],
    triggers: [appointmentTrigger],
  });

  // The whole mount is one fetch handler, so this is all a host has to do on a
  // fetch-native runtime. Express and Fastify hosts wrap it once with
  // createRequestListener from @rova/core/node instead.
  const httpServer = Bun.serve({ port, fetch: rova.fetch });

  console.log("[example] configurable server started", {
    url: httpServer.url.toString(),
    triggerType: APPOINTMENT_TRIGGER_TYPE,
    actionId: "appointments/cancel",
    note: "Use the built-in frontend as usual. Create a workflow with trigger Appointment Lifecycle and add the Cancel Appointment action.",
  });
}

main().catch((error) => {
  console.error("[example] failed to start", error);
  process.exit(1);
});
