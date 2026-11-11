---
name: mcp
description: >
  Use when letting an MCP client, such as a coding agent or an app built on an
  MCP SDK, author workflows in an embedded Workflow Graph app: turning on the
  mcp option of createWfGraphApp or wfWorker, admitting a deployed hostname
  with mcp.allowedHostnames and mcp.allowedOriginHostnames, accepting and
  verifying the client's bearer token in the auth function, advertising an
  OAuth authorization server with mcp.authorization, granting the operations
  each tool needs, or explaining a 401, a 403, a workflow_draft_stale result or
  a refused publish from the endpoint. Also use for requests such as "connect
  our coding agent to the workflow editor", "the MCP client cannot sign in"
  or "let an agent publish workflows". For the editor's own chat agent use
  wfgraph-core/build-agent; for roles and custom grants in general use
  wfgraph-core/auth.
metadata:
  purpose: >
    Turn on and secure Workflow Graph's stateless MCP authoring endpoint: the
    mcp option, Host and Origin allowlists, bearer tokens checked by the host's
    auth function, mcp.authorization discovery, per-tool grants, and the
    draft-revision protocol a client follows from creating a workflow to
    publishing it.
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
requires:
  - wfgraph-core
sources:
  - alandotcom/wfgraph:docs/embedding.md
  - alandotcom/wfgraph:packages/core/src/backend/agent/mcp-server.ts
---

This skill builds on wfgraph-core, and the access policy itself is
wfgraph-core/auth. Copy the option forms from `docs/embedding.md` ("MCP
authoring").

# The MCP authoring endpoint

`mcp` mounts a Model Context Protocol endpoint at `{basePath}/api/mcp` on
`createWfGraphApp` or `wfWorker`. It is off by default. An MCP client reads the
host's catalog, creates workflows, and reads and edits their drafts through the
same tools the editor's build agent calls, and it can also publish and restore
versions. Every request passes through the host's `auth` function, as an editor
request does.

## Procedure

1. **Admit the hostname.** `mcp: true` accepts localhost alone. A deployed
   host passes `mcp: { allowedHostnames, allowedOriginHostnames }`, hostnames
   with no scheme or port. A client that is not a browser sends no `Origin`, so
   `allowedOriginHostnames` may be empty for it. Result: a request whose
   `Host` is the deployed name is not answered `403`.
2. **Accept the client's token in `auth`.** An MCP client authenticates with
   `Authorization: Bearer <token>`, and it holds no editor cookie. Read that
   header beside the session cookie, verify the token with whatever issued it,
   and answer the client's role policy. Workflow Graph issues and checks no
   MCP token itself. Result: a request with no token, or with a token the
   function rejects, answers `401`, and a request with a valid token reaches
   the tools.
3. **Advertise where a token comes from (optional).** Set
   `mcp.authorization: { authorizationServers, scopesSupported? }`. Result:
   `GET /.well-known/oauth-protected-resource{basePath}/api/mcp` answers the
   RFC 9728 metadata outside `auth`, and the `401` carries
   `WWW-Authenticate: Bearer resource_metadata="..."`, so a client can find
   the authorization server on its own. Without the option the challenge is a
   bare `Bearer`.
4. **Grant what the client's tools need.** Each tool checks the operations in
   the tool grants table on every call, and a call the policy does not grant
   answers an `isError` result with `reason: "Forbidden"`. Result:
   `WfGraphRoles.editor` reaches every tool, because its permissions cover
   every operation in the table, and `WfGraphRoles.viewer` reads drafts and
   runs while each write answers `Forbidden`.
5. **Point the client at the URL.** The server sends the authoring rules as
   its `instructions`, and a `build_workflow` prompt carries the same rules for
   a client that shows prompts. Result: the client lists the tools and its
   first write is the Lifecycle Node.

## Core Patterns

### Protocol

The endpoint serves revision `2026-07-28` and the 2025-era revisions
`2024-10-07` through `2025-11-25`, statelessly: each `POST` is one JSON-RPC
message, no `Mcp-Session-Id` is issued, `GET` and `DELETE` answer `405`, and
tools and prompts advertise `listChanged: false`. A request body is capped at
1 MiB. The cross-site write rule that guards the editor's routes does not apply
to this endpoint; the Host and Origin allowlists do.

### Tool grants

| Tools                                                              | Operation each call checks                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `list_actions`, `describe_action`, `list_events`, `describe_event` | None beyond signing in. They take no `workflowId`, so a client explores before it creates |
| `list_integrations`                                                | `integration.getAll`, since the answer holds Connection ids                               |
| `list_workflows`, `create_workflow`                                | `workflow.getAll`, `workflow.create`                                                      |
| Every read of a draft                                              | `workflow.getById`                                                                        |
| Every write, `apply_edits` included                                | `workflow.getById` and `workflow.update`                                                  |
| `list_runs`, `read_run`, `start_test_run`                          | `workflow.getExecutions`, `workflow.getExecutionLogs`, `workflow.execute`                 |
| `list_field_options`                                               | `action.configOptions` for a host action, `integration.configOptions` for an integration  |
| `publish_workflow`, `list_versions`, `restore_version`             | `workflow.publish`, `workflow.getVersionHistory`, `workflow.restoreVersion`               |

No tool returns or decrypts a Connection's credentials.

### The draft-revision protocol

- `create_workflow` answers `workflowId` and `draftRevision`. It is not
  idempotent.
- Every read answers the stored `draftRevision`. Every write takes it back as
  `expectedDraftRevision`, advances it once, and answers the new value with
  `newIssues`, the validation issues the write added.
- `apply_edits` applies an ordered list of node and edge operations as one
  write under one revision. A refused operation stores nothing, and a step an
  operation creates can carry a `key` that later operations name as `$key`.
- `validate_workflow` answers `canSave`, `canPublish`, `saveIssues`,
  `publishBlockers` and `warnings`. `publish_workflow` refuses a draft with
  blockers and lists every one.
- `restore_version` replaces the draft with a published version, which is a
  client's undo. MCP writes leave the published version alone until
  `publish_workflow`.
- A write that leaves a Group with fewer than two steps ungroups it, and the
  result names that Group. No tool creates or ungroups a Group.

### Answers that are not successes

- Arguments that do not match a tool's schema: an `isError` result naming each
  wrong field, so the model can correct the call.
- An unknown tool name: JSON-RPC error `-32602`.
- A write sent with an old revision: an `isError` result with code
  `workflow_draft_stale`, the stored `draftRevision`, and a statement that
  nothing was written.
- An unaccepted `Host` or `Origin`: `403` naming `mcp.allowedHostnames` or
  `mcp.allowedOriginHostnames`, without the hostname that was sent.

## Common Mistakes

### CRITICAL A bearer token nobody verifies

Wrong: `auth` that answers a role for any request carrying
`Authorization: Bearer ...`, or `mcp.authorization` set on the assumption
that Workflow Graph checks the token.

Correct: verify the token in `auth` with the authorization server or the
host's own token store, and answer `null` for one that fails.

`mcp.authorization` only tells a client where to get a token. Any string then
reaches every tool the role grants, publishing included.

Source: alandotcom/wfgraph:docs/embedding.md (MCP authoring)

### HIGH An auth function that reads only the editor's cookie

Wrong: the editor's `auth`, which reads a session cookie, left unchanged when
`mcp` is turned on.

Correct: read `Authorization: Bearer` as well, and keep the cookie path for
the editor and the OAuth callback.

An MCP client sends no cookie, so every call answers `401`.

Source: alandotcom/wfgraph:docs/embedding.md (MCP authoring)

### HIGH mcp: true on a deployed host

Wrong: `mcp: true` in production.

Correct: `mcp: { allowedHostnames: ["workflows.example.com"], allowedOriginHostnames: [] }`.

`true` admits localhost alone, so every request to the deployed name answers
`403` naming `mcp.allowedHostnames`.

Source: alandotcom/wfgraph:docs/embedding.md (MCP authoring)

### HIGH Repeat a stale write

Wrong: send the same write again after a `workflow_draft_stale` result.

Correct: call `read_workflow`, decide the edit again against the stored
draft, and send it with the returned `draftRevision`.

A stale write was planned against graph state another editor has since
changed, and Workflow Graph replays nothing for the client.

Source: alandotcom/wfgraph:docs/embedding.md (MCP authoring)

### HIGH Retry create_workflow after an unknown result

Wrong: call `create_workflow` again after a timeout or a dropped connection.

Correct: call `list_workflows` and look for the workflow by name first.

Creation is not idempotent, so a retry after a creation that did land makes a
second workflow with the same name.

Source: alandotcom/wfgraph:docs/embedding.md (MCP authoring)

### MEDIUM Publish on canSave

Wrong: call `publish_workflow` once `validate_workflow` answers
`canSave: true`.

Correct: publish when `canPublish` is true. A draft can save while a
Connection is missing or a template names a node that is not upstream, and
`publish_workflow` then refuses it with the blockers.

Source: alandotcom/wfgraph:docs/embedding.md (MCP authoring)

### MEDIUM start_test_run treated as a dry run

Wrong: grant `workflow.execute` to a client on the assumption that
`start_test_run` only simulates.

Correct: a test run calls every action handler it reaches with
`runMode: "test"`, so each handler with a side effect checks `runMode`
(wfgraph-core/host-actions). The tool is annotated open-world and not
read-only for that reason.

Source: alandotcom/wfgraph:docs/embedding.md (Test runs call your handler)

## Completion

The endpoint is done when these hold against the deployed name:

- A `tools/list` with no token answers `401`, with `resource_metadata` in its
  challenge when `mcp.authorization` is set, and the metadata document
  answers `200` naming the authorization server.
- A token `auth` rejects answers `401`; the issued token lists the tools.
- `list_actions` answers with no `workflowId`, and `create_workflow` answers a
  `workflowId` and a `draftRevision`.
- The editor still loads with a session cookie.

`packages/evals/src/skills/mcp/mcp-endpoint.test.ts` in the Workflow Graph
repository asserts each of these over HTTP.
