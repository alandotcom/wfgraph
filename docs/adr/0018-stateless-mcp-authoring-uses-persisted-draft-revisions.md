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
