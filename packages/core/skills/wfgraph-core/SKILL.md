---
name: wfgraph-core
description: >
  Embed Workflow Graph with createWfGraphApp, defineEvent, defineAction, and
  persistence (wfPostgres, wfSqlite, wfWorker). Write integrations with
  defineIntegration against @wfgraph/core/plugin. Load when mounting the host
  app, declaring Events or host actions, or building a third-party integration.
metadata:
  type: core
  library: wfgraph
  library_version: "3.1.1"
sources:
  - alandotcom/wfgraph:README.md
  - alandotcom/wfgraph:docs/embedding.md
---

# Workflow Graph — core

Workflow Graph is a self-hosted workflow engine you embed. Your code declares
Events, actions, and integrations; your team builds graphs in the editor.

Nothing registers on import. Pass values in `extensions`.

```bash
pnpm add @wfgraph/core @wfgraph/client @wfgraph/plugins inngest hono
```

`inngest` and `hono` are peer dependencies. `@wfgraph/plugins` is optional (built-ins).
`@wfgraph/client` is the built editor bundle passed as `client`.

## Sub-skills

| Need to...                                      | Load                      |
| ----------------------------------------------- | ------------------------- |
| Mount `createWfGraphApp`, auth, Inngest, editor | wfgraph-core/embed        |
| `defineEvent`, intake, Lifecycle                | wfgraph-core/events       |
| `defineAction` (Promise host actions)           | wfgraph-core/host-actions |
| Postgres, SQLite, Workers, migrate              | wfgraph-core/persistence  |
| Write an integration package                    | wfgraph-core/integrations |
| Turn on Clerk/Linear/Resend/Slack/Twilio        | wfgraph-plugins           |

## Quick decision tree

- First embed? → embed, then events and host-actions
- Persistence choice? → persistence
- Custom vendor actions with credentials? → integrations (not host-actions)
- Only the five built-ins? → wfgraph-plugins

## Version

Targets `@wfgraph/core` v3.1.1. Skills version with the installed package.
