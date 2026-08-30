---
name: persistence
description: >
  wfPostgres, wfSqlite, wfWorker, wfHyperdrive, migrateWfGraphDatabase. Schema
  search_path, Hyperdrive query cache off, runOnStartup migrations. Load when
  choosing a database backend, Cloudflare Workers, or applying SQL migrations.
metadata:
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
sources:
  - alandotcom/wfgraph:docs/embedding.md
---

This skill builds on wfgraph-core and wfgraph-core/embed.

# Persistence

`createWfGraphApp` takes one opaque `persistence` value. Connection, schema,
migrations, and transactions stay inside the backend.

## Setup

PostgreSQL 15+ (url **or** separate fields, not both):

```ts
import { wfPostgres } from "@wfgraph/core/postgres";

persistence: wfPostgres({
  url: process.env.DATABASE_URL!,
  schema: "_workflows",
  migrations: { runOnStartup: true },
}),
```

```ts
persistence: wfPostgres({
  host: "db.internal",
  port: 5432,
  user: "wfgraph",
  password: process.env.PGPASSWORD!,
  database: "app",
  schema: "_workflows",
  maxConnections: 10,
  ssl: "require",
  migrations: { runOnStartup: false },
}),
```

SQLite (embedded; creates and migrates on open):

```ts
import { wfSqlite } from "@wfgraph/core/sqlite";

persistence: wfSqlite({ filename: "./wfgraph.db" });
// wfSqlite() is in-memory and dies with the process.
```

## Core Patterns

### Postgres schema rules

Default schema is `_workflows`. Tables are unqualified; `search_path` places
them. A schema name must be an unquoted lowercase identifier of 63 characters
or less. A `url` must not carry a `search_path` query parameter. Behind
PgBouncer 1.22+, set `track_extra_parameters=search_path`.

### Migrations

`runOnStartup` defaults to `false`. Out of band:

```ts
import { migrateWfGraphDatabase } from "@wfgraph/core/migrate";

await migrateWfGraphDatabase({ url: process.env.DATABASE_URL! });
```

Same connection fields as `wfPostgres`. Do not apply the shipped SQL with
`psql` — files are schema-agnostic and would land in `public`.

### Cloudflare Workers

Use `@wfgraph/core/worker`, not `createWfGraphApp`:

```ts
import { wfHyperdrive, wfWorker } from "@wfgraph/core/worker";

export default wfWorker<Env>({
  publicUrl: "https://workflows.example.com",
  request: (env) => ({
    auth: (request) => hasValidSession(request),
    persistence: wfHyperdrive(env.HYPERDRIVE),
    encryption: { key: env.INTEGRATION_ENCRYPTION_KEY },
    inngest: { id: "my-wfgraph-worker", signingKey: env.INNGEST_SIGNING_KEY },
  }),
  extensions: (env) => ({ events, actions, integrations }),
});
```

Disable Hyperdrive query caching. Set the origin role's default `search_path`
so `_workflows` (or your `schema`) is first. Migrate out of band with
`@wfgraph/core/migrate`. Enable `nodejs_compat`.

## Common Mistakes

### HIGH Mix url and discrete postgres fields

Wrong:

```ts
wfPostgres({ url: process.env.DATABASE_URL!, host: "db.internal" });
```

Correct: one form only. Mixed values fail to compile and are refused at runtime.

Source: alandotcom/wfgraph:docs/embedding.md (Persistence)

### HIGH search_path on the URL

Wrong:

```ts
wfPostgres({ url: "postgres://.../?options=-csearch_path%3D_workflows" });
```

Correct: pass `schema: "_workflows"`. The URL parameter outranks the option.

Source: alandotcom/wfgraph:docs/embedding.md

### HIGH Apply drizzle SQL with psql

Wrong: `psql $DATABASE_URL -f node_modules/@wfgraph/core/drizzle/...`

Correct: `migrateWfGraphDatabase` or `wfPostgres({ migrations: { runOnStartup: true } })`.

Source: alandotcom/wfgraph:docs/embedding.md (PostgreSQL migrations)

### HIGH Hyperdrive with query caching

Wrong: default Hyperdrive caching on.

Correct: disable query caching; Workflow Graph's writes would otherwise be
invisible to later reads.

Source: alandotcom/wfgraph:docs/embedding.md (Cloudflare Workers and Hyperdrive)
