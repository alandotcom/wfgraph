---
name: embed
description: >
  Mount Workflow Graph with createWfGraphApp: fetch handler, createRequestListener,
  auth, INTEGRATION_ENCRYPTION_KEY, Inngest connect, clientBundle, publicUrl,
  basePath, configureWfGraphLogging. Load when embedding the host app or wiring
  Express, Fastify, Node http, or the editor bundle.
metadata:
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
sources:
  - alandotcom/wfgraph:docs/embedding.md
  - alandotcom/wfgraph:README.md
---

This skill builds on wfgraph-core. Read it first.

# Embed Workflow Graph

`createWfGraphApp` returns a fetch handler: `(request: Request) => Promise<Response>`.

## Setup

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
import { configureWfGraphLogging } from "@wfgraph/core/logging";
import { wfPostgres } from "@wfgraph/core/postgres";
import { builtInIntegrations } from "@wfgraph/plugins";

configureWfGraphLogging();

const appointmentCreated = defineEvent({
  name: "app/appointment.created",
  label: "Appointment created",
  description: "Raised for each new appointment.",
  schema: z.object({
    appointment: z.object({
      id: z.string().describe("Appointment ID"),
      startsAt: z.iso.datetime(),
    }),
  }),
  correlationPath: "appointment.id",
});

const wfgraph = await createWfGraphApp({
  publicUrl: "https://workflows.example.com",
  persistence: wfPostgres({
    url: process.env.DATABASE_URL!,
    schema: process.env.DATABASE_SCHEMA,
    migrations: { runOnStartup: true },
  }),
  encryption: { key: process.env.INTEGRATION_ENCRYPTION_KEY },
  auth: (request) => hasValidSession(request),
  client: clientBundle,
  inngest: {
    id: "my-wfgraph-app",
    baseUrl: process.env.INNGEST_BASE_URL,
    eventKey: process.env.INNGEST_EVENT_KEY,
    signingKey: process.env.INNGEST_SIGNING_KEY,
    connect: true,
  },
  extensions: {
    events: [appointmentCreated],
    actions: [],
    integrations: builtInIntegrations(),
  },
});

createServer(createRequestListener(wfgraph)).listen(3000);
```

`INTEGRATION_ENCRYPTION_KEY` is a 64-character hex string. `auth` is required.
An import of an Event or integration is inert until it is listed in `extensions`.

## Core Patterns

### Fetch-native mount

```ts
Bun.serve({ port: 3000, fetch: wfgraph.fetch });
```

### Express / Fastify — before body parsers, same path as `basePath`

```ts
const app = express();
app.use("/workflows", createRequestListener(wfgraph));
app.use(express.json());
```

Express strips the matched path; the adapter reads `req.originalUrl`. A body
parser in front of Workflow Graph drains the request and Inngest signature
verification then fails with a 500 that names the fix.

### Editor

Pass `client` from `@wfgraph/client` (`clientBundle`) to serve the SPA from
`wfgraph.fetch`. In this repo's `pnpm run dev`, Vite serves the editor and
`client` stays unset. Production `pnpm run start` passes the built bundle.

### Logging

Call `configureWfGraphLogging()` before `createWfGraphApp`, or pass `logger`, or
sink LogTape category `wfgraph` yourself. With none of those, start-up warns
once and records go nowhere. Never log a request body, Event payload, or step
output.

### OAuth host requirements

OAuth needs `publicUrl` (HTTPS except loopback). The callback stays behind
`auth`; a `SameSite=Lax` session cookie works, a custom request header on the
provider redirect does not. Route table: `docs/embedding.md` ("Built-in
integrations"). Slack/Resend wiring: load wfgraph-plugins.

## Common Mistakes

### CRITICAL Omit auth

Wrong:

```ts
await createWfGraphApp({ persistence, encryption, inngest /* no auth */ });
```

Correct:

```ts
await createWfGraphApp({
  auth: (request) => hasValidSession(request),
  persistence,
  encryption,
  inngest,
});
```

Workflow Graph refuses to start without `auth`. The failure mode to avoid is an
editor the internet can open that decrypts integration secrets.

Source: alandotcom/wfgraph:docs/embedding.md (createWfGraphApp options)

### HIGH Body parser in front of the listener

Wrong:

```ts
app.use(express.json());
app.use("/workflows", createRequestListener(wfgraph));
```

Correct:

```ts
app.use("/workflows", createRequestListener(wfgraph));
app.use(express.json());
```

Inngest verifies the raw body. A drained request cannot be rebuilt.

Source: alandotcom/wfgraph:docs/embedding.md (Mounting on Node)

### HIGH Mount path disagrees with basePath

Wrong:

```ts
await createWfGraphApp({ basePath: "/" /* ... */ });
app.use("/workflows", createRequestListener(wfgraph));
```

Correct:

```ts
await createWfGraphApp({ basePath: "/workflows" /* ... */ });
app.use("/workflows", createRequestListener(wfgraph));
```

The adapter logs once when they disagree; OAuth callback URLs will be wrong.

Source: alandotcom/wfgraph:docs/embedding.md (Mounting on Node)

### MEDIUM Encryption key not 64 hex chars

Wrong:

```ts
encryption: {
  key: process.env.SECRET!;
}
```

Correct:

```ts
encryption: {
  key: process.env.INTEGRATION_ENCRYPTION_KEY;
}
// 64-character hex, e.g. openssl rand -hex 32
```

Source: alandotcom/wfgraph:docs/embedding.md (createWfGraphApp options)
