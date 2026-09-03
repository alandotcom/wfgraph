# Plan: add a stateless MCP authoring server

Status: architecture and release scope approved on 2026-09-03.
The repository is at commit `e5a4cf05` on `agent-quality/mcp-adapter`.

This plan replaces the turn-scoped MCP session design in commit `e5a4cf05` and
the uncommitted custom-runner prototype. It preserves the direct tool path used
by the built-in agent and exposes the same authoring behavior to external MCP
clients.

## Goal

Add an opt-in MCP endpoint that lets an authenticated external agent read,
edit, and validate an existing workflow draft. The endpoint edits
`workflows.graph`, which is the same editable draft the visual editor saves.

The built-in agent continues to run behind `agent.chat`. It invokes the
canonical Effect toolkit directly against the graph supplied by the browser.
The MCP endpoint invokes the same toolkit through a transport adapter.

## Decisions

The implementation uses the following decisions:

- `@wfgraph/agent` remains the canonical owner of tool names, descriptions,
  model-facing schemas, handlers, validation, and refusal meanings.
- The built-in model loop calls the canonical toolkit directly through
  `AgentToolSession`.
- External agents call one public MCP endpoint at `${basePath}/api/mcp`.
- The MCP endpoint is disabled unless the host opts in through
  `WfGraphAppOptions.mcp`.
- Each MCP request is independent. The implementation uses no protocol session,
  `Mcp-Session-Id`, process-local draft registry, sticky routing, or
  initialization handshake.
- Each workflow-scoped MCP call carries `workflowId`. Each write also carries
  `expectedDraftRevision`.
- A stale write returns a recoverable tool error. The server does not replay the
  mutation automatically.
- A successful MCP graph write runs the shared automatic layout before saving.
  Tool schemas do not expose node positions or a layout command.
- Publication remains separate. The first release exposes no create, delete,
  duplicate, restore, run, or publish tool.
- The first release edits a workflow whose ID the caller already knows. Workflow
  discovery and creation can be designed as separate lifecycle tools later.
- The MCP endpoint supports the 2026-07-28 protocol only and rejects legacy
  traffic.
- An editor learns about an external MCP write on its next workflow load. The
  first release adds conflict protection, not cross-client live collaboration.
  Built-in agent graph parts continue to update the open canvas during a turn.
- The rejected host-supplied custom-runner surface is removed. A future remote
  runner can use the public MCP endpoint as an external client.

The tool ownership, stateless request model, persisted draft ownership,
automatic layout decisions, and the following release-scope assumptions are
approved:

- Hosts opt in with `WfGraphAppOptions.mcp`; the endpoint is disabled by
  default.
- The endpoint path is `${basePath}/api/mcp`.
- The first release edits existing workflows only. It has no workflow list,
  create, restore, delete, run, or publish tools.
- External MCP writes become visible in an open editor after a reload. The first
  release does not add polling, server-sent events, or another cross-client
  revision channel.

## Actors and state owners

| Actor               | Calls                               | State read or written                               | Observable result                  |
| ------------------- | ----------------------------------- | --------------------------------------------------- | ---------------------------------- |
| Workflow Builder    | The browser editor                  | Browser graph and persisted workflow draft          | Canvas updates and save status     |
| Built-in agent      | `agent.chat` and `AgentToolSession` | Request-local copy of the browser graph             | Existing `AgentStreamPart` stream  |
| External agent host | MCP endpoint                        | Persisted workflow draft selected by `workflowId`   | MCP tool result and draft revision |
| MCP adapter         | Core draft-tool execution service   | No cross-request state                              | One response for one request       |
| Workflow service    | `WorkflowRepo`                      | `workflows.graph` and `draft_revision`              | Conditional draft write            |
| Publish service     | Existing publish procedures         | Immutable workflow versions and publication pointer | Unchanged by MCP draft editing     |

`workflows.graph` remains the system of record for a persisted editable draft.
The browser graph can contain newer unsaved edits. The built-in agent receives
that browser graph directly, so it keeps those edits without an MCP round trip.

## Representative flows

### Built-in agent write

1. The browser reads its current nodes and edges when a turn starts.
2. The browser calls `agent.chat` with the current graph and messages.
3. `postAgentChat` creates one `AgentToolSession` from the supplied graph,
   catalog, and integration identities.
4. The built-in model loop invokes the session toolkit directly.
5. A successful write emits one graph revision through `AgentStreamPart`.
6. `applyAgentGraphAtom` creates the first-write undo boundary, applies the
   shared layout, updates the canvas, and requests an immediate save.
7. The save includes the browser's expected persisted draft revision. A
   concurrent external write produces a conflict and leaves the local graph
   unsaved rather than overwriting the stored draft.

The built-in path retains its current stream, trace, cancellation, and undo
ownership.

### External MCP write

1. The external host sends one authenticated `tools/call` request containing
   `workflowId`, `expectedDraftRevision`, and the canonical tool arguments.
2. The host authentication hook authenticates the HTTP request.
3. The MCP adapter checks the required Workflow Graph operation grants.
4. A core service loads the workflow, catalog, and integration identities.
5. The service rejects a stale `expectedDraftRevision` before executing the
   tool.
6. The service creates one request-local `AgentToolSession` from the stored
   graph and executes one canonical tool.
7. A canonical refusal returns an MCP tool result with `isError: true` and does
   not write the draft.
8. A successful write applies the shared layout and the graph save-shape checks.
9. `WorkflowRepo` conditionally stores the graph and increments
   `draft_revision` in one database statement or transaction.
10. The MCP result contains the canonical result and the resulting draft
    revision. The request-local session is discarded.

Any application replica can execute the flow because the database holds every
cross-request value.

## Public and internal contracts

### Persisted draft revision

Add `draft_revision` to the PostgreSQL and SQLite `workflows` tables.

- A newly inserted workflow starts at revision `1`.
- A successful graph write increments the revision atomically.
- Metadata-only writes leave the draft revision unchanged.
- A graph write requires an expected revision.
- Restore-as-draft and the legacy current-workflow save use the same conditional
  write contract, so no graph writer bypasses concurrency control.
- Publish continues to compare publication state through
  `expectedPublishedVersionId`. Draft revision and published version remain
  separate concepts.

Expose `draftRevision` on `WorkflowApiPayload`. Add the expected revision to
every RPC input that writes an existing draft graph.

Replace the graph-capable generic repository update with two explicit methods:

```ts
updateMetadata(input): Effect<Workflow | null, DatabaseError>

writeDraft(input): Effect<
  | { status: "updated"; workflow: Workflow }
  | { status: "conflict"; currentDraftRevision: number }
  | { status: "not_found" },
  DatabaseError
>
```

`writeDraft` can also carry metadata that the editor merged into the same save
request. The repository updates that metadata and the graph atomically after
the revision predicate matches.

Add a `DraftConflict` domain failure with a stable shared wire code and the
current draft revision. The RPC adapter maps it to the existing conflict status.
The MCP adapter maps it to a recoverable tool result.

### MCP tool envelope

The adapter extends each canonical input schema with transport state. It removes
the transport fields before calling the canonical handler.

Every tool receives:

```ts
{
  workflowId: string;
  // Canonical tool arguments follow.
}
```

Every write tool also receives:

```ts
{
  expectedDraftRevision: number;
}
```

Each structured result includes `workflowId` and `draftRevision` beside the
canonical result fields. The tool description tells the client to call
`read_workflow` again after a draft conflict. The adapter preserves canonical
failure fields such as `reason`.

The MCP-only envelope is the transport contract. Canonical handlers remain
unaware of workflow IDs, database revisions, HTTP, and MCP.

### Authorization

The MCP route stays behind the host authentication middleware. The adapter
checks grants before loading a workflow:

- Graph and catalog reads require `workflow.getById`.
- Graph writes require both `workflow.getById` and `workflow.update`.
- `list_integrations` requires `integration.getAll` in addition to
  `workflow.getById` because its result contains Connection IDs.

The fixed `tools/list` response does not vary by caller. A refused tool call does
not disclose whether an unauthorized workflow exists.

### Integration data

Add a repository read that returns only integration IDs and types. Use it in
both `postAgentChat` and the MCP draft-tool service. Do not call
`IntegrationRepo.listByType` for agent authoring because that method decrypts
credential configuration that the tools never use.

### Layout

Move the runtime-neutral layout algorithm and its pure dependencies from the
client package to `@wfgraph/shared`. The move includes the persisted node size
constants, Event Split reachability needed for outlet sizing, and Group child
layout helpers. React Flow view-model code remains in `@wfgraph/client`.

The client continues to call the shared layout when it applies a built-in agent
graph part. The MCP draft-tool service calls the same function after every
successful canonical write and before `prepareGraphSave` and `writeDraft`.

### MCP protocol and HTTP behavior

Use `createMcpHandler` from the current MCP TypeScript SDK integration and create
a fresh server for each request. Configure `legacy: "reject"`.

The endpoint implements the following behavior:

- Support `server/discover`, `tools/list`, and `tools/call` for protocol
  revision 2026-07-28.
- Require request protocol version, client identity, and client capabilities in
  request `_meta` as specified by the protocol.
- Return server identity in result `_meta`.
- Enforce matching `MCP-Protocol-Version`, `Mcp-Method`, and applicable
  `Mcp-Name` headers.
- Return the SDK's `UnsupportedProtocolVersionError` for unsupported versions.
- Refuse legacy initialization, GET streams, DELETE termination, transport
  sessions, and request batches that bypass the one-message HTTP model.
- Apply the existing capped-body reader before JSON-RPC parsing.
- Pass the request `AbortSignal` into Effect execution.
- Return argument and protocol errors as JSON-RPC errors. Return tool refusals,
  missing workflows, and draft conflicts as `isError: true` tool results.

Request logs can contain the MCP method, tool name, workflow ID, duration,
result category, and revision number. Logs must omit tool arguments, tool
results, workflow graphs, Event payloads, and integration configuration.

## Implementation sequence

Use RED, GREEN, REFACTOR for every behavior change. Each phase ends with its
focused tests passing.

### Phase 1: remove the rejected prototype

1. Delete `mcp-sessions.ts` and its tests.
2. Remove the custom-runner files and the uncommitted custom-runner wiring from
   `app.ts`, `runtime.ts`, `api-app.ts`, `router.ts`, `worker.ts`, `index.ts`,
   agent configuration, runner input, service tests, and the eval harness.
3. Retain `AgentRunner`, `AgentToolSession`, the built-in runner, and normalized
   tracing.
4. Replace `mcp-server.ts` and its tests during later phases rather than
   preserving the session-oriented interface.
5. Preserve the unrelated `scripts/dev-with-tunnel.sh` file and the approved
   `AGENTS.md` clarification change.

Acceptance:

- The built-in agent and eval harness use the direct toolkit path.
- No type or runtime contract mentions an MCP session registry or custom
  runner.
- Focused runner, agent service, and eval harness tests pass.

### Phase 2: stop opening integration secrets for agent authoring

1. Add the ID-and-type-only read to `IntegrationRepo` and both persistence
   backends.
2. Add the read to persistence conformance tests and repository test layers.
3. Change `postAgentChat` to use the new read.
4. Keep the `ConnectedIntegration` input type unchanged.

Acceptance:

- Creating an agent tool session performs no credential decryption.
- The built-in agent sees the same integration IDs and types.
- An encryption-key mismatch cannot prevent an authoring turn that only needs
  integration identities.

### Phase 3: add the persisted draft revision contract

1. Add `draftRevision` to the PostgreSQL and SQLite workflow schemas.
2. Generate both migrations with `pnpm run db:generate` and
   `pnpm run db:generate:sqlite`. Do not hand-write migration SQL.
3. Add `draftRevision` to workflow row mappers, API payload types, Effect
   schemas, fixtures, and client `SavedWorkflow` state.
4. Add `updateMetadata` and `writeDraft` to `WorkflowRepo`. Remove graph writes
   from the unconstrained update method.
5. Implement compare-and-swap in PostgreSQL and SQLite. Return the current
   revision on a conflict.
6. Route `patchWorkflow`, restore-as-draft, and current-workflow saves through
   `writeDraft`.
7. Add `DraftConflict` and its shared wire code.
8. Make the browser save queue send its expected revision with graph patches and
   advance the local revision only after a successful response.
9. On conflict, retain the failed graph patch and the local canvas, stop blind
   retries, and show a conflict-specific save error that tells the Workflow
   Builder to reload the stored draft before saving again.

Acceptance:

- Two writes using revision `N` cannot both succeed.
- The winner returns revision `N + 1`.
- The loser returns the current revision and does not modify graph or metadata.
- Metadata-only updates do not change the draft revision.
- PostgreSQL and SQLite pass the same concurrency cases.
- The editor never silently overwrites an MCP write with a stale graph.
- A built-in agent turn still starts from the unsaved browser graph.

### Phase 4: align tool success with graph save validation

1. Add a failing tool test that constructs a topology-valid mutation whose CEL
   model fails `validateGraphSaveShape`.
2. Give `WorkflowDraft` a save-shape validation callback or an equivalent
   runtime-neutral refusal callback that runs inside `update` before a tool
   reports success.
3. Supply the production save-shape check from core and a deliberate stub from
   direct tool tests.
4. Keep publication readiness in `validateAgentDraft`; do not move publish-only
   checks into ordinary draft writes.

Acceptance:

- A graph that persistence would refuse is refused by the canonical write tool.
- A refused update leaves the document and revision history unchanged.
- Built-in and MCP paths return the same refusal reason.

If the RED test proves that existing handlers cannot create the invalid shape,
record that result and omit the new callback. Do not add a second validation
layer without a demonstrated gap.

### Phase 5: share automatic layout

1. Move the pure layout implementation and required pure helpers into
   `@wfgraph/shared`.
2. Move the existing client layout tests with the implementation or duplicate
   only adapter-specific assertions.
3. Keep `applyAgentGraphAtom` calling the shared function.
4. Add a core test that applies layout after an accepted graph write.

Acceptance:

- Existing layout fixtures produce the same positions.
- The built-in agent keeps one undo boundary and live canvas re-layout.
- An MCP `add_node` call stores usable positions without accepting position
  arguments.
- Rejected and conflicted writes store no layout changes.

### Phase 6: add the core draft-tool execution service

1. Add a core service near `backend/services/agent/` that executes one canonical
   tool call against one persisted draft.
2. Classify canonical tools as reads or writes from `WRITE_TOOL_NAMES`.
3. Load `Extensions`, integration identities, and the workflow through their
   services and repositories.
4. Create one `AgentToolSession`, execute one tool, and collect its encoded
   result.
5. Return read and canonical-refusal results with the loaded revision.
6. For successful writes, apply layout, run save-shape validation, and call
   `writeDraft` with the expected revision.
7. Translate repository conflicts into `DraftConflict`. Do not retry the tool.
8. Keep tool arguments and results available to the caller and out of production
   log fields.

Acceptance:

- The service has no HTTP or MCP types.
- Each invocation reads all state from repositories and application services.
- A second application runtime can execute the next call from the revision
  returned by the first runtime.
- Cancellation interrupts tool execution and prevents a later save.

### Phase 7: add the stateless MCP adapter

1. Replace the prototype server with an adapter over the draft-tool execution
   service.
2. Derive canonical tool descriptions and schemas from `agentToolkit`.
3. Add `workflowId` and `expectedDraftRevision` to the MCP-facing schemas.
4. Register a fresh server per request through `createMcpHandler` with modern-only
   protocol handling.
5. Mount the route only when `WfGraphAppOptions.mcp` is enabled.
6. Keep the route behind host authentication and perform tool-specific operation
   checks before service execution.
7. Apply the request body cap and propagate request cancellation.
8. Add payload-free MCP request fields to the existing one-record request log.

Acceptance:

- Two sequential calls can reach different app replicas and use only
  `workflowId` and draft revision to continue.
- No response or request uses `Mcp-Session-Id`.
- No request requires `initialize` or `notifications/initialized`.
- `server/discover` and server result metadata identify Workflow Graph.
- Unsupported versions and mismatched headers return the protocol-defined error
  codes.
- Unauthorized and forbidden requests reach no workflow or integration read.
- The Worker build accepts the same stateless handler.

### Phase 8: prove native and MCP conformance

1. Build table-driven fixtures for every canonical tool.
2. Execute each fixture directly and through an in-process MCP client from the
   same graph, catalog, and integration identities.
3. Compare canonical structured results, refusal state, and semantic final
   graphs. Compare positions for successful write calls after both paths apply
   shared layout.
4. Assert that every canonical tool appears in `tools/list` and that no extra
   graph mutation tool exists.
5. Add focused tests for malformed arguments, invalid workflow IDs, missing
   grants, stale revisions, request cancellation, oversized bodies, modern-only
   protocol negotiation, and payload-free logs.
6. Add a two-runtime persistence test that reads through one runtime and writes
   through another.

Acceptance:

- Direct and MCP invocation produce equivalent tool behavior.
- Tool refusals and conflicts leave the stored graph unchanged.
- One successful write increments the persisted revision once.
- The MCP adapter retains no mutable cross-request state.

### Phase 9: finish the adopter-visible change

1. Document MCP enablement, endpoint URL, host authentication, required
   permissions, workflow and revision arguments, conflict recovery, and the
   first-release lifecycle limits in `docs/embedding.md`.
2. Update the published workflow-authoring skill when the exposed authoring
   contract changes.
3. Add a changeset for `@wfgraph/core` and the fixed package group.
4. Verify the packed `@wfgraph/core` manifest and MCP entry reachability.
5. Run the required repository checks and `git diff --check`.

Acceptance:

- A host can enable the endpoint and connect a current MCP client using only the
  published package and host authentication.
- The documentation does not promise create or publish support.
- The package contains no rejected session-registry or custom-runner surface.

## Test matrix

| Area              | Required cases                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Canonical tools   | Success, declared refusal, unchanged graph after refusal, save-shape refusal                                       |
| Draft persistence | Initial revision, increment, stale write, deletion race, metadata-only update, restore conflict                    |
| Browser saves     | Revision propagation, sequential queue updates, stale conflict, preserved local graph, built-in turn undo boundary |
| Layout            | Existing fixtures, Event Split widths, Groups, repeatability, MCP-created nodes                                    |
| MCP protocol      | Discovery, list, call, metadata, header mismatch, unsupported version, legacy rejection, cancellation, body cap    |
| Authorization     | Authentication failure, read grant, write grant, integration-list grant, no existence leak                         |
| Statelessness     | Calls on different runtimes, no session header, no process-local draft, stale revision recovery                    |
| Observability     | One request record, aggregate fields, no arguments, results, graph, Event payload, or integration config           |
| Packaging         | Node app, Worker build, packed exports and dependencies                                                            |

## Required checks

Run focused tests after each RED, GREEN, REFACTOR cycle. Before the MCP pull
request finishes, run:

```bash
pnpm run type-check
pnpm run lint
pnpm run test
pnpm run build
pnpm run knip
pnpm run skills:validate
pnpm run fix
git diff --check
```

Because the plan changes workflow persistence and both schemas, also run:

```bash
docker compose up -d
pnpm run test:postgres
```

Do not commit `vitest-results.json`. Do not modify or commit
`scripts/dev-with-tunnel.sh`.

## Completion boundary

The MCP pull request is complete when an authenticated external client can edit
an existing persisted draft through modern stateless MCP, direct and MCP calls
pass the same tool-conformance cases, stale browser and MCP writes cannot
overwrite each other, and the built-in agent retains its existing stream and
undo behavior.

PR 6 regression automation starts after this pull request is green and reviewed.
