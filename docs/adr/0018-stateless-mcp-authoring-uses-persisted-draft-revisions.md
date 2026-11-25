# 18. Stateless MCP authoring uses persisted draft revisions

Date: 2026-09-03

## Status

Accepted.

## Context

Workflow Graph had two workflow-authoring paths with different state owners.
The built-in agent edited the browser's graph during an `agent.chat` request.
An external Model Context Protocol (MCP) client needed to edit a persisted draft
through an HTTP endpoint.

A process-local MCP session could retain a draft between calls, but a later call
might reach another application replica. Process-local state would also become a
second source of truth beside `workflows.graph`. Concurrent browser and MCP
writes could overwrite each other if the persisted draft had no revision check.

The canonical tools in `@wfgraph/agent` already owned workflow-edit validation
and refusal behavior. A separate MCP tool implementation would let the two
authoring paths diverge.

## Decision

Workflow Graph added one opt-in MCP endpoint at `${basePath}/api/mcp`. The
endpoint accepts one independent JSON-RPC message per request and retains no
protocol session or process-local draft state. It supports MCP protocol revision
`2026-07-28` and rejects legacy initialization and session transports.

Each workflow-specific call carries a `workflowId`. Each graph write also
carries the latest `expectedDraftRevision`. The persisted `workflows.graph` and
`draft_revision` values are the system of record. The workflow repository
compares and increments the revision in the same write that stores the graph.

Both authoring paths use the canonical `@wfgraph/agent` toolkit. The built-in
agent calls the toolkit directly against the browser graph. The MCP adapter
loads a persisted draft, runs one canonical tool call, applies the shared
automatic layout, and conditionally saves the result.

The MCP surface lists workflows, creates drafts, and edits existing drafts.
Publication, execution, deletion, duplication, and restore remain outside the
MCP surface. The endpoint is disabled by default and remains behind host
authentication and operation-level authorization.

## Consequences

Any application replica can handle any MCP request because the database holds
all cross-request state. A stale write returns the stored revision and leaves
the draft unchanged. The client must read the workflow again before it submits
a revised edit.

An open editor learns about an external MCP write when the editor reloads the
workflow. The endpoint provides conflict protection, but it does not provide
live cross-client updates.

The `create_workflow` operation is not idempotent. A client must not
automatically retry the operation when the result is unknown.

The canonical tool schemas do not expose node positions. Workflow Graph applies
the same layout to built-in agent and MCP writes before persistence.

## Amendment: open editors follow persisted draft revisions

Date: 2026-09-04

The editor added an authenticated server-sent events subscription while a
workflow was open. The serving replica polled the persisted draft revision and
emitted only newer revisions. Each event carried the revision as its event ID,
so a reconnect resumed after the last received revision. When the persisted
revision advanced, a clean Draft canvas loaded the saved graph and fitted the
updated workflow into view. The database remained the cross-replica source of
truth, and the MCP endpoint remained stateless.

The editor preserved unsaved browser edits and active built-in agent turns. If
an external write advanced the persisted revision during local work, the editor
reported the conflict and required the Workflow Builder to reload the persisted
draft explicitly.

## Amendment: 2025-era clients are served statelessly

Date: 2026-11-11

The endpoint began serving 2025-era protocol revisions through the MCP SDK's
stateless legacy path. The SDK's default client opened with the 2025
`initialize` handshake, so the strict endpoint refused it with an unsupported
protocol version. The legacy path answered each request from a fresh server and
kept no transport session, which matched the stateless design: the persisted
draft revision remained the only cross-request state. `GET` and `DELETE`
session operations still answered 405.

## Amendment: authoring writes place new steps only

Date: 2026-11-11

Built-in agent and MCP writes stopped re-running full automatic layout. A full
layout discarded positions a person had set by hand on every write. Each write
placed only the steps it added, beside a neighbour that already had a position,
and left every other step where it was. A graph with no positioned step was
still laid out whole.

## Amendment: each model provider moved to its own entry

Date: 2026-11-25

No ADR recorded the built-in agent's model providers, so this amendment records
them beside the authoring decision for that agent.

The `agent` option had taken plain data with a `provider` key naming OpenAI,
Anthropic, OpenRouter or an OpenAI-compatible server, and
`packages/core/src/backend/agent/model.ts` imported all four Effect provider
packages statically. Every entry that reached the app, `@wfgraph/core/worker`
included, therefore loaded all four at startup, whether the host configured an
agent or not, and a host used at most one. Cloudflare allows a Worker 1 second
of startup CPU. Measured on a Worker with no integrations, local startup took
120 ms as shipped, 91 ms with no provider bundled, and 93 to 110 ms with exactly
one: about 93 ms for OpenAI or an OpenAI-compatible server, about 100 ms for
Anthropic and about 110 ms for OpenRouter. The four packages were about 1.6 MiB
of that Worker's 5.9 MiB.

A dynamic `import()` of the provider was rejected. In a single-file Worker
bundle, esbuild wraps the target of a dynamic import, and every module it imports
statically, in a lazy initializer, which measured 3.6 MiB larger and about 10 ms
slower for these four packages.

Each provider moved to its own package entry: `@wfgraph/core/openai`,
`@wfgraph/core/anthropic`, `@wfgraph/core/openrouter` and
`@wfgraph/core/openai-compatible`, exporting `wfOpenAi`, `wfAnthropic`,
`wfOpenRouter` and `wfOpenAiCompatible`. The host imports the one it uses
statically and passes what the function returns as `agent`, the way it passes
what `wfPostgres` returns as `persistence`. The returned value carries the
function that builds the provider's `LanguageModel` layer for a turn, so core's
agent code no longer switches on a provider name. The plain-data form, with or
without a `provider` key, was removed with no compatibility path. The host's own
runner form, `{ runner, maxConcurrentTurns }`, was unchanged.
`scripts/plugins/worker-bundle.test.ts` gained a case that fails when a module
of a provider package reaches the bundle of `@wfgraph/core/worker`.

## Amendment: the MCP server moved to its own entry

Date: 2026-11-25

The `mcp` option had taken `true`, for localhost, or a plain object of allowed
hostnames, allowed origin hostnames and an optional `authorization`.
`packages/core/src/backend/api-app.ts` imported
`packages/core/src/backend/agent/mcp-server.ts` statically, and that module
imported `@modelcontextprotocol/server` and built its tool argument schemas
when it loaded. Every entry that reached the app, `@wfgraph/core/worker`
included, therefore loaded the MCP server package and its `zod` dependency at
startup, whether the host set `mcp` or not. Measured on a Worker with no
integrations and no model provider, local startup took 91 ms with the MCP
server bundled and 72 ms without it, and the bundle held 4,367 KiB of code
against 3,731 KiB. A dynamic `import()` was rejected for the reason the
provider amendment records.

The MCP server moved to its own package entry, `@wfgraph/core/mcp`, which
exports `wfMcp`. The host passes what `wfMcp()` returns as `mcp` for the
localhost defaults `mcp: true` had given, or what `wfMcp(options)` returns for
the options the object form had taken. The returned value carries what
`api-app.ts` calls to mount and serve the endpoint, and the option's types
moved to `packages/core/src/backend/agent/mcp-option.ts`, which imports no MCP
SDK, so no module the other entries reach imports from the MCP server's
modules. `mcp: true` and the plain-object form were
removed with no compatibility path, and a JavaScript host that passes either
one is refused at startup with a message naming `wfMcp`. The endpoint's path,
its Host and Origin validation, its authentication challenge, its
protected-resource metadata, its tools and its body size cap were unchanged.
The case in `scripts/plugins/worker-bundle.test.ts` that the provider
amendment added now bundles every entry in core's "exports" map, and fails
when a module of a provider package, of `@modelcontextprotocol/` or of `zod`
reaches an entry other than the one that owns it. `@wfgraph/core/inngest` may
also bundle `zod`, because the `inngest` SDK depends on it.
