# Skill spec — Workflow Graph

Skills teach an adopter's coding agent how to embed `@wfgraph/core` and how to
author integrations against `@wfgraph/core/plugin`. They are derived from the
public host manuals. Do not invent APIs. Do not copy `AGENTS.md` or
`packages/plugins/src/AGENTS.md` (those are for this repository).

## Audience

Developers embedding Workflow Graph in a host app, or writing an integration
package they will pass to `createWfGraphApp` under `extensions.integrations`.

## Constraints

- An import registers nothing. The host turns Events, actions, and integrations
  on by passing values in `extensions`.
- Host `defineEvent` / `defineAction` are Promise-first and take any Standard
  Schema library. Integration handlers are Effect and build against
  `@wfgraph/core/plugin`.
- Skills stay under 500 lines. Common Mistakes are grounded in the manuals.
- `@wfgraph/client` has no skill: pass `clientBundle` into `createWfGraphApp`.
