# @wfgraph/core

The backend half of [Workflow Graph](https://github.com/alandotcom/wfgraph), a self-hosted
workflow engine you embed in your own application. This package holds the run engine, the
authoring vocabulary your code declares its domain in, and `createWfGraphApp`, which returns a
fetch handler you mount in a server you own.

```bash
npm install @wfgraph/core hono
```

`hono` is a required peer dependency. Workflow Graph builds its routes on Hono inside
`createWfGraphApp`, and the peer dependency makes your application install the one Hono
copy that runs in its process, even when your own code never imports it.

```ts
import { createServer } from "node:http";
import {
  createRequestListener,
  createWfGraphApp,
  WfGraphRoles,
} from "@wfgraph/core";
import { wfPostgres } from "@wfgraph/core/postgres";

const wfgraph = await createWfGraphApp({
  persistence: wfPostgres({
    url: process.env.DATABASE_URL!,
    migrations: { runOnStartup: true },
  }),
  encryption: { key: process.env.INTEGRATION_ENCRYPTION_KEY },
  // Answer the session's access policy, or null when nobody is signed in.
  auth: async (request) => {
    const session = await readSession(request);
    return session ? WfGraphRoles[session.role] : null;
  },
  extensions: { events: [], actions: [], integrations: [] },
});

createServer(createRequestListener(wfgraph)).listen(3000);
```

For SQLite, `wfSqlite()` is in memory and `wfSqlite({ filename: "./wfgraph.db" })`
persists to a file:

```ts
import { wfSqlite } from "@wfgraph/core/sqlite";
```

Runs on Node 24 with PostgreSQL 15 or newer or native SQLite. A host that sends Events with
`inngest.send` adds `inngest` and registers the forwarders from `@wfgraph/core/inngest`. Add
[`@wfgraph/client`](https://www.npmjs.com/package/@wfgraph/client) for the visual editor and
[`@wfgraph/plugins`](https://www.npmjs.com/package/@wfgraph/plugins) for the built-in
integrations; the three are released together and always share a version.

## Docs

- [Embedding](https://github.com/alandotcom/wfgraph/blob/main/docs/embedding.md), which covers
  mounting, the database, options, and every package export
- [Events](https://github.com/alandotcom/wfgraph/blob/main/docs/events.md) for `defineEvent`
- [Integrations](https://github.com/alandotcom/wfgraph/blob/main/docs/integrations.md) for
  `defineIntegration`
- [Domain vocabulary](https://github.com/alandotcom/wfgraph/blob/main/CONTEXT.md)

Apache-2.0.
