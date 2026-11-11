# Workflow Graph

[![npm](https://img.shields.io/npm/v/@wfgraph/core.svg)](https://www.npmjs.com/package/@wfgraph/core)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/alandotcom/wfgraph)

A self-hosted workflow engine you embed in your application. Your code declares the
vocabulary — Events, actions, and integrations — and your team builds workflows in a visual
editor.

| Role                 | Who                       | What they do                                                |
| -------------------- | ------------------------- | ----------------------------------------------------------- |
| **Event Author**     | The developer who embeds  | Defines Events, actions, and which integrations to turn on  |
| **Workflow Builder** | Their less technical team | Builds the graph and declares Lifecycle Rules in the editor |

Workflow Graph runs on your infrastructure. Workflow runs execute in your Node process and
keep their state in your PostgreSQL or SQLite database. Events arrive in an inbox table in
that database, sent from your code, over HTTP, from a webhook, or through Inngest with the
forwarders from `@wfgraph/core/inngest`.

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
# Optional: mounts POST /api/events, which takes this as a bearer token.
WFGRAPH_EVENTS_KEY=$(openssl rand -hex 32)
# Optional: enables Slack OAuth. See .env.example for the redirect URL to
# register on the Slack app.
SLACK_CLIENT_ID=your-slack-client-id
SLACK_CLIENT_SECRET=your-slack-client-secret
EOF

# Two processes: the example app on :4017 and the editor on :5173.
pnpm run dev
```

The example app runs workflows and delivers Events in its own worker loop, so nothing else
has to be running. To raise an Event from a shell, post it to the events route with the
`WFGRAPH_EVENTS_KEY` from `.env.local`:

```bash
curl -X POST http://localhost:4017/api/events \
  -H "Authorization: Bearer $WFGRAPH_EVENTS_KEY" -H "Content-Type: application/json" \
  -d '{"name":"billing/payment.settled","data":{"appointmentId":"appt_1","amountCents":5000,"settledAt":"2026-08-10T19:00:00.000Z"}}'
```

Open the editor at [http://localhost:5173](http://localhost:5173). The example host app lives
in `examples/app.ts`. Sign in at `/login` as `admin`, `editor`, or `readonly`. Each local
demo account uses the password `password`. Set `WFGRAPH_DEMO_USER=admin` in `.env.local` to
skip the login page in development.

The example app stores its data in SQLite, at `examples/wfgraph.sqlite`, which is gitignored
and created on first boot. There is no migration step and no separate service. Point
`SQLITE_PATH` somewhere else to move the file, and delete it to start over.

The build agent is optional. Set `OPENAI_API_KEY` in `.env.local` to enable the Agent panel.
The key stays on the server; the browser sends chat requests to the host app, which calls the
configured model. Leave the variable empty to run the editor without the agent.

Production-style single process (built client handed to the app):

```bash
pnpm run build
pnpm run start
```

## Run in GitHub Codespaces

1. Select the **Open in GitHub Codespaces** badge.
2. Create the codespace.
3. Wait for the setup command to finish.

The setup command installs the workspace and creates the required encryption key. The
codespace starts the development stack and keeps its own SQLite database. After the app
starts, Codespaces opens the forwarded **Workflow Graph** port. Sign in with any demo account
listed in **Run locally**. If startup fails, read `/tmp/wfgraph-dev.log` in the codespace.

## Test workflow reliability

`pnpm run test:reliability` exercises admission recovery, late cancellation, Entity
Eligibility Exit, and Group execution through the real application and its worker loop,
sending every Event with `app.events.send`. It runs fixed regression examples and
generated cases on SQLite and PostgreSQL. Each case creates and closes its own application
and database.
The cancellation, Exit, and Group properties run every case three times: ungrouped, and
with a vertical and a horizontal Group around part of the graph. Each run must reach the
expected outcome, and the grouped runs must match the ungrouped run. The property
families run in separate worker processes. Pass `--maxWorkers=1` to run them
sequentially.

```bash
docker compose up -d
WFGRAPH_TEST_DATABASE_URL=postgresql://workflow:workflow@localhost:55437/workflow_builder \
  pnpm run test:reliability
```

For SQLite alone, use `WFGRAPH_RELIABILITY_BACKEND=sqlite`. Set
`WFGRAPH_RELIABILITY_RUNS` to change the generated case count, which defaults to five,
and `WFGRAPH_RELIABILITY_GROUP_RUNS` to change the Group property's count, which
defaults to three. Failures write evidence
under `test-results/reliability/` and print a replay command with
`WFGRAPH_RELIABILITY_SEED` and `WFGRAPH_RELIABILITY_PATH`. The seed reproduces generated
inputs; test controls coordinate the repository failure windows. The ordinary
`pnpm run test` suite runs separately.

## Embed in your app

```bash
pnpm add @wfgraph/core @wfgraph/client hono
```

`hono` is a peer dependency, so your application owns the version that runs in its process.
Add `@wfgraph/plugins` for the built-in integrations. An application that publishes Events
with `inngest.send` also installs `inngest`, an optional peer dependency, and registers the
forwarders from `@wfgraph/core/inngest` (see `docs/events.md`).

The published packages include Agent Skills (TanStack Intent). After install, run
`pnpm dlx @tanstack/intent@latest install`, then `pnpm dlx @tanstack/intent@latest list`
and `pnpm dlx @tanstack/intent@latest load @wfgraph/core#wfgraph-core` when embedding
or writing an integration.

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
  WfGraphRoles,
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
  description: "Cancels an appointment and records the reason.",
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
  // Answer the session's access policy, or null when nobody is signed in.
  auth: async (request) => {
    const session = await readSession(request);
    return session ? WfGraphRoles[session.role] : null;
  },
  client: clientBundle,
  extensions: {
    events: [appointmentCreated],
    actions: [cancelAppointment],
    integrations: builtInIntegrations(),
  },
});

createServer(createRequestListener(wfgraph)).listen(3000);
```

See [Authentication and authorization](docs/embedding.md#authentication-and-authorization)
for role semantics, custom grants, and trusted upstream authentication.

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
| [`docs/integrations.md`](docs/integrations.md) | `defineIntegration`, OAuth adapters, handlers, schemas, testing  |
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
