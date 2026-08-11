# Workflow Graph

[![npm](https://img.shields.io/npm/v/@wfgraph/core.svg)](https://www.npmjs.com/package/@wfgraph/core)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A self-hosted workflow engine you embed in your application. Your code declares the
vocabulary — Events, actions, and integrations — and your team builds workflows in a visual
editor.

| Role                 | Who                       | What they do                                                |
| -------------------- | ------------------------- | ----------------------------------------------------------- |
| **Event Author**     | The developer who embeds  | Defines Events, actions, and which integrations to turn on  |
| **Workflow Builder** | Their less technical team | Builds the graph and declares Lifecycle Rules in the editor |

Workflow Graph runs on your infrastructure (Node, PostgreSQL, Inngest) and uses your database.

## Run locally

Prerequisites: Node 24, pnpm (see `packageManager` in `package.json`), Docker (or a local
Postgres on port `55437`).

```bash
# Start Postgres (db/user/password: workflow / workflow / workflow)
docker compose up -d

# Install
pnpm install

# Root .env.local (gitignored). DATABASE_URL falls back in examples/app.ts.
cat > .env.local <<EOF
DATABASE_URL=postgresql://workflow:workflow@localhost:55437/workflow_builder
INTEGRATION_ENCRYPTION_KEY=$(openssl rand -hex 32)
EOF

pnpm run db:migrate

# App :4017, editor :5173, Inngest CLI :8388
pnpm run dev
```

Open the editor at [http://localhost:5173](http://localhost:5173). The example host app lives
in `examples/app.ts`.

Production-style single process (built client handed to the app):

```bash
pnpm run build
pnpm run start
```

## Embed in your app

`createWfGraphApp` returns a fetch handler. Pass Events, actions, and integrations in one
`extensions` object:

```ts
import { createServer } from "node:http";
import { z } from "zod";
import { clientBundle } from "@wfgraph/client";
import {
  createRequestListener,
  createWfGraphApp,
  defineAction,
  defineEvent,
} from "@wfgraph/core";
import { builtInIntegrations } from "@wfgraph/plugins";

const appointmentCreated = defineEvent({
  name: "app/appointment.created",
  label: "Appointment created",
  schema: z.object({
    appointment: z.object({
      id: z.string().describe("Appointment ID"),
      startsAt: z.iso.datetime(),
    }),
  }),
  correlationPath: "appointment.id",
});

const cancelAppointment = defineAction({
  id: "appointments/cancel",
  label: "Cancel Appointment",
  category: "Appointments",
  input: z.object({
    appointmentId: z.string().describe("Appointment ID"),
    reason: z.string().min(1),
  }),
  output: z.object({
    appointmentId: z.string(),
    status: z.string(),
  }),
  handler({ input }) {
    return { appointmentId: input.appointmentId, status: "cancelled" };
  },
});

const wfgraph = await createWfGraphApp({
  database: {
    url: process.env.DATABASE_URL!,
    migrations: { runOnStartup: true },
  },
  encryption: { key: process.env.INTEGRATION_ENCRYPTION_KEY },
  auth: (request) => hasValidSession(request),
  client: clientBundle,
  inngest: { id: "my-wfgraph-app", connect: true },
  extensions: {
    events: [appointmentCreated],
    actions: [cancelAppointment],
    integrations: builtInIntegrations,
  },
});

createServer(createRequestListener(wfgraph)).listen(3000);
```

`examples/app.ts` is the canonical host. If this README disagrees with it, the example wins.

## Docs

| Doc                                            | What it covers                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| [`docs/embedding.md`](docs/embedding.md)       | Mounting, editor, database, migrations, package exports, options |
| [`docs/events.md`](docs/events.md)             | `defineEvent`, umbrella sources, intake, Lifecycle model         |
| [`docs/integrations.md`](docs/integrations.md) | `defineIntegration`, handlers, schemas, testing                  |
| [`CONTEXT.md`](CONTEXT.md)                     | Domain vocabulary                                                |
| [`docs/adr/`](docs/adr/)                       | Design decisions                                                 |

## Packages

The three published packages release together and always carry the same version, so the editor
can never be installed against a backend whose API contract it no longer matches.

| Package                                                              | What it is                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------- |
| [`@wfgraph/core`](https://www.npmjs.com/package/@wfgraph/core)       | Run engine, authoring vocabulary, `createWfGraphApp` |
| [`@wfgraph/client`](https://www.npmjs.com/package/@wfgraph/client)   | The editor, as a built bundle                        |
| [`@wfgraph/plugins`](https://www.npmjs.com/package/@wfgraph/plugins) | The six built-in integrations                        |

`@wfgraph/shared` holds types the three have in common. It stays private and is inlined at
build time, so it never appears as a dependency of anything you install.
