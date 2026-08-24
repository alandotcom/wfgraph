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

Workflow Graph runs on your infrastructure (Node, PostgreSQL or SQLite, and Inngest).

## Run locally

Prerequisites: Node 24 and pnpm (see `packageManager` in `package.json`).

```bash
# Install
pnpm install

# Root .env.local (gitignored)
cat > .env.local <<EOF
INTEGRATION_ENCRYPTION_KEY=$(openssl rand -hex 32)
# Optional: enables the build agent in the editor.
OPENAI_API_KEY=your-openai-api-key
EOF

# App :4017, editor :5173. The Inngest CLI takes free ports and prints its own.
# INNGEST_DEV_PORT pins that one.
pnpm run dev
```

Open the editor at [http://localhost:5173](http://localhost:5173). The example host app lives
in `examples/app.ts`.

It stores its data in SQLite, at `examples/wfgraph.sqlite`, which is gitignored and created
on first boot. There is no migration step and no separate service. Point `SQLITE_PATH`
somewhere else to move the file, and delete it to start over.

The build agent is optional. Set `OPENAI_API_KEY` in `.env.local` to enable the Agent panel.
The key stays on the server; the browser sends chat requests to the host app, which calls the
configured model. Leave the variable empty to run the editor without the agent.

Production-style single process (built client handed to the app):

```bash
pnpm run build
pnpm run start
```

## Embed in your app

```bash
pnpm add @wfgraph/core @wfgraph/client inngest hono
```

`inngest` and `hono` are peer dependencies, so your application owns the version of each
that runs in its process. Add `@wfgraph/plugins` for the built-in integrations.

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
import { wfPostgres } from "@wfgraph/core/postgres";
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
  persistence: wfPostgres({
    url: process.env.DATABASE_URL!,
    migrations: { runOnStartup: true },
  }),
  encryption: { key: process.env.INTEGRATION_ENCRYPTION_KEY },
  agent: { apiKey: process.env.OPENAI_API_KEY },
  auth: (request) => hasValidSession(request),
  client: clientBundle,
  inngest: { id: "my-wfgraph-app", connect: true },
  extensions: {
    events: [appointmentCreated],
    actions: [cancelAppointment],
    integrations: builtInIntegrations(),
  },
});

createServer(createRequestListener(wfgraph)).listen(3000);
```

`examples/app.ts` is the canonical host. If this README disagrees with it, the example wins.

For embedded SQLite, use `wfSqlite()` for an ephemeral in-memory database or
pass a file to keep data across restarts:

```ts
import { wfSqlite } from "@wfgraph/core/sqlite";

persistence: wfSqlite(); // in memory
persistence: wfSqlite({ filename: "./wfgraph.db" }); // persistent
```

See [Embedding: Persistence](docs/embedding.md#persistence) for PostgreSQL,
SQLite, and Cloudflare Hyperdrive setup.

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
| [`@wfgraph/plugins`](https://www.npmjs.com/package/@wfgraph/plugins) | The five built-in integrations                       |

`@wfgraph/shared` holds types the three have in common. It stays private and is inlined at
build time, so it never appears as a dependency of anything you install.
