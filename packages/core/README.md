# @wfgraph/core

The backend half of [Workflow Graph](https://github.com/alandotcom/wfgraph), a self-hosted
workflow engine you embed in your own application. This package holds the run engine, the
authoring vocabulary your code declares its domain in, and `createWfGraphApp`, which returns a
fetch handler you mount in a server you own.

```bash
npm install @wfgraph/core
```

```ts
import { createServer } from "node:http";
import { createRequestListener, createWfGraphApp } from "@wfgraph/core";

const wfgraph = await createWfGraphApp({
  database: {
    url: process.env.DATABASE_URL!,
    migrations: { runOnStartup: true },
  },
  encryption: { key: process.env.INTEGRATION_ENCRYPTION_KEY },
  auth: (request) => hasValidSession(request),
  inngest: { id: "my-wfgraph-app", connect: true },
  extensions: { events: [], actions: [], integrations: [] },
});

createServer(createRequestListener(wfgraph)).listen(3000);
```

Runs on Node 24, PostgreSQL 15 or newer, and Inngest. Add
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
