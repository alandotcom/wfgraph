---
name: auth
description: >
  Use when deciding who can open and change an embedded Workflow Graph app:
  writing the auth callback for createWfGraphApp or wfWorker with
  defineWfGraphAuth, mapping host sessions to the viewer, editor and admin
  policies in WfGraphRoles, building a custom policy from the host's own grants
  with WfGraphAccess.fromPermissions or fromOperationIds, choosing
  trustWfGraphUpstream behind a gateway that authorizes every request, or
  explaining a 401, 403 or 500 from the Workflow Graph API. Also use for
  requests such as "let support staff see runs but not edit workflows", "only
  admins may manage connections" or "the workflow editor fails to load after we
  changed our login". For the other createWfGraphApp options use wfgraph-core;
  for turning on the built-in OAuth integrations use wfgraph-plugins.
metadata:
  purpose: >
    Write the host access policy for Workflow Graph with defineWfGraphAuth,
    WfGraphRoles, WfGraphAccess and trustWfGraphUpstream.
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
requires:
  - wfgraph-core
sources:
  - alandotcom/wfgraph:docs/embedding.md
  - alandotcom/wfgraph:packages/core/src/backend/lib/http/authorize.ts
  - alandotcom/wfgraph:packages/shared/src/authorization/operations.ts
---

This skill builds on wfgraph-core. Copy the callback example and the
permission and operation tables from `docs/embedding.md` ("Authentication and
authorization").

# Authentication and authorization

`auth` is a required option of `createWfGraphApp`, and a required field of the
object a Worker's `request(env)` callback returns. It is a callback that reads
the host's own session from the request and returns an access policy for that
request, or `null` when the request has no session. Workflow Graph stores no
principal, so host identity, organization and grants stay in the callback's
closure.

A policy grants application capabilities: which operations a session may call,
such as `workflow.publish`. A granted operation acts on every Workflow Graph
record it addresses. Tenant isolation and per-record ownership belong to the
host, for example one app per tenant.

Every name in this skill is exported from `@wfgraph/core` and from
`@wfgraph/core/worker`.

## Procedure

1. **Read the session.** Write the callback with `defineWfGraphAuth`, read the
   host's session from headers and cookies, and return `null` when there is
   none. Workflow Graph passes the callback a clone of the request, so reading
   its body drains nothing, but a session belongs in a cookie or header.
   Result: a request with no session answers `401 Unauthorized`.
2. **Return a role policy.** Map the session's role to `WfGraphRoles.viewer`,
   `WfGraphRoles.editor` or `WfGraphRoles.admin`. Result: a viewer can read
   workflows and is refused a publish with `403 Forbidden`; an editor can
   create and publish.
3. **Build a custom policy only for custom roles.** Load the session's grants
   once inside the callback, then return
   `WfGraphAccess.fromPermissions(grants)`. Use
   `WfGraphAccess.fromOperationIds(operationIds)` only when a role grants some
   operations of a permission and withholds others. Both copy the collection
   into an immutable local policy. Result: one request reads the grant store
   once.
4. **Grant everything only on purpose.** Return `WfGraphAccess.all` for a
   session that should have unrestricted access. Pass `trustWfGraphUpstream()`
   only when an upstream component authenticates and authorizes every operator
   request before it reaches Workflow Graph.
5. **Keep OAuth reachable.** When any integration offers OAuth, the provider's
   callback reaches Workflow Graph as a top-level browser redirect and still
   passes through this callback. Authenticate it from a `SameSite=Lax` session
   cookie. Result: connecting a Slack, Resend or PostHog account completes.

## Core Patterns

### Role policies

| Role     | Permissions                                                           |
| -------- | --------------------------------------------------------------------- |
| `viewer` | `workflow.read`, `run.read`, `connection.read`                        |
| `editor` | viewer, plus `workflow.write`, `run.manage`, `agent.use`              |
| `admin`  | every operation, including `connection.write` (= `WfGraphAccess.all`) |

`WfGraphPermissions` holds the seven permission names as constants,
`WfGraphOperations` holds each operation's `{ id, permission }` descriptor,
and `WfGraphOperationIds` lists every operation id. Read those exports for the
full operation list; the OpenAPI document served at `/api/openapi.json` names
each route's operation id and its `x-wfgraph-permission`.

### What each answer means

| Callback or policy outcome                                          | Answer                            |
| ------------------------------------------------------------------- | --------------------------------- |
| The callback returns `null`                                         | `401 Unauthorized`                |
| `allows(operation)` returns `false`                                 | `403 Forbidden`                   |
| The callback throws or rejects                                      | `500`, details logged server-side |
| The callback returns something without an `allows` function         | `500`, details logged server-side |
| `allows` throws, rejects, or answers something other than a boolean | `500`, details logged server-side |

A `500` is a host-system failure. Workflow Graph logs the cause on the
request's `wfgraph.http` record (`wfgraph.http.auth` for the editor page
itself), and the response body is `{ "error": "Internal Server Error" }`.

### Routes the callback never sees

Two machine routes carry a credential of their own and skip the callback: a
Connection's webhook intake (`POST /api/webhooks/{type}/{connectionId}`,
verified by the vendor's signature) and `POST /api/events` (mounted only when
`events.key` is set, sent with `Authorization: Bearer <key>`). The OAuth client
metadata route is public provider-discovery data. Every other route, the editor
page included, goes through the callback.

### The editor's grant snapshot

`GET /api/extensions` carries `authorization.operationIds`, built by calling
`allows` for every operation concurrently. The editor hides or disables what
the snapshot does not grant, and keeps it for the life of the page, so an
operator reloads after a role change. A policy failure there fails the editor's
startup with a `500`. Each protected operation calls `allows` again when it
runs, so the snapshot is presentation only.

## Common Mistakes

### CRITICAL A policy that grants everything

Wrong: `defineWfGraphAuth(() => WfGraphAccess.all)`, or
`trustWfGraphUpstream()` on a host with no upstream authorizer.

Correct: return `null` for a request with no session and a role policy for a
session. Return `WfGraphAccess.all` only for a session that should be an admin.

Every request, anonymous ones included, can then read and publish workflows and
manage connections, and a connection holds decrypted integration credentials.

Source: alandotcom/wfgraph:docs/embedding.md (Authentication and authorization)

### HIGH Throwing for a missing session

Wrong: `if (!session) throw new Error("not signed in")`.

Correct: `if (!session) return null`.

A throw is a host-system failure: the request answers `500` and logs an error,
and the editor shows a broken page where a sign-in redirect belongs.

Source: alandotcom/wfgraph:docs/embedding.md (Authentication and authorization)

### HIGH A grant-store query inside allows

Wrong: `{ allows: async (operation) => (await loadGrants(userId)).includes(operation.permission) }`.

Correct: `WfGraphAccess.fromPermissions(await loadGrants(userId))`, with the
load inside the authentication callback.

The editor's boot snapshot calls `allows` once per operation, concurrently, so
a query inside it runs about forty times for one page load.

Source: alandotcom/wfgraph:docs/embedding.md (Authentication and authorization)

### MEDIUM Header-only authentication

Wrong: a callback that accepts only `Authorization: Bearer <token>` from the
editor's requests.

Correct: authenticate from a `SameSite=Lax` session cookie, which the
provider's redirect to the OAuth callback carries.

The OAuth callback stays behind `auth`, and a top-level redirect from the
provider carries cookies and no custom headers, so every OAuth connection
fails at its last step.

Source: alandotcom/wfgraph:docs/embedding.md (Built-in integrations)

## Completion

The policy is done when these hold against the running app:

- A request with no session to `GET /api/rest/workflows` answers `401`.
- A viewer's `POST /api/rest/workflows/{id}/publish` answers `403`, and an
  editor's answers `200`.
- `GET /api/extensions` for each role lists the operation ids that role should
  have, and loading it reads the host's grant store once.
- With an OAuth integration enabled, connecting an account through the editor
  completes.

A `500` on any of these means the callback or a policy threw; the
`wfgraph.http` record for that request names the cause.
