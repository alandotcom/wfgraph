---
name: integrations
description: >
  Write a Workflow Graph integration with defineIntegration, callExternal,
  IntegrationOAuth, runAction, and checkIntegration against @wfgraph/core/plugin.
  Load when building a vendor plugin, credential forms, OAuth adapters, or
  integration tests. Not for host defineAction.
metadata:
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
sources:
  - alandotcom/wfgraph:docs/integrations.md
---

This skill builds on wfgraph-core. Host `defineAction` is wfgraph-core/host-actions.

# Writing an integration

An integration is one `defineIntegration` value. Nothing registers on import.
The host passes it in `extensions.integrations`.

Build against `@wfgraph/core/plugin` alone. Test with `@wfgraph/core/testing`.

## Sub-skills

| Need to...                                        | Load                                |
| ------------------------------------------------- | ----------------------------------- |
| Credentials, inline actions, config form, schemas | wfgraph-core/integrations/authoring |
| `callExternal`, replay, Effect vs Promise         | wfgraph-core/integrations/http      |
| `IntegrationOAuth` adapter                        | wfgraph-core/integrations/oauth     |
| `runAction`, `checkIntegration`, evolve / retire  | wfgraph-core/integrations/testing   |
| Turn on the five built-ins                        | wfgraph-plugins                     |

## Quick decision tree

- New vendor? → authoring, then http, then testing
- Token grant from the vendor? → oauth (Core owns the browser flow)
- Host-owned app action with no vendor SDK? → host-actions, not this tree

## Invariants

- Action slug exists only as the `actions` record key; id is `${type}/${slug}`.
- Handler stays an object literal inside `defineIntegration`.
- Integration handlers are Effect; connection `test` and OAuth token writes are
  Promise at the edge (`callExternalAsync`).
- Call out through `callExternal` unless the SDK owns protocol (JWT, GraphQL).
