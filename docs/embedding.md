# Embedding Workflow Graph

How to mount Workflow Graph in a host application: `createWfGraphApp`, the editor, integrations, database, migrations, package exports, options, logging, and tracing.

`createWfGraphApp` returns a fetch handler: `(request: Request) => Promise<Response>`.

```bash
pnpm add @wfgraph/core @wfgraph/client @wfgraph/plugins hono
```

A host that publishes its Events with `inngest.send` also installs `inngest` and registers
the forwarders from `@wfgraph/core/inngest`; see Sending through Inngest in
`docs/events.md`.

An import hands you a value and stops there. The `extensions` option turns that value on,
and it holds the full surface an application has.

```ts
import { createServer } from "node:http";
import { z } from "zod";
import { clientBundle } from "@wfgraph/client";
import {
  createRequestListener,
  createWfGraphApp,
  defineAction,
  defineEvent,
} from "@wfgraph/core";
import { auth } from "./wfgraph-auth";
import { wfPostgres } from "@wfgraph/core/postgres";
import { builtInIntegrations } from "@wfgraph/plugins";

// An Event your application raises. See docs/events.md.
const appointmentCreated = defineEvent({
  name: "app/appointment.created",
  label: "Appointment created",
  description: "The app raises this Event for each new appointment.",
  schema: z.object({
    appointment: z.object({
      id: z.string(),
      startsAt: z.iso.datetime(),
    }),
  }),
  correlationPath: "appointment.id",
});

// One of your own actions, beside the actions of the built-in integrations.
const cancelAppointment = defineAction({
  id: "appointments/cancel",
  label: "Cancel Appointment",
  description: "Cancels an appointment and records the reason.",
  // The heading the action selector lists it under. Defaults to "Custom".
  category: "Appointments",
  // This schema draws the config form. The editor derives readable labels from
  // property keys ("appointmentId" becomes "Appointment ID"). JSON Schema
  // `description` adds help text; `title` overrides a label when needed.
  input: z.object({
    appointmentId: z.string(),
    reason: z.string().min(1),
  }),
  // What `handler` returns. This schema also drives template autocomplete.
  output: z.object({
    appointmentId: z.string(),
    status: z.string(),
    cancelledAt: z.iso.datetime(),
  }),
  // A throw fails the node. The run log shows the message.
  handler({ input }) {
    return {
      appointmentId: input.appointmentId,
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
    };
  },
});

const wfgraph = await createWfGraphApp({
  publicUrl: "https://workflows.example.com",
  persistence: wfPostgres({
    url: process.env.DATABASE_URL!,
    // Workflow Graph puts its tables in "_workflows". This option names a different schema.
    schema: process.env.DATABASE_SCHEMA,
    migrations: { runOnStartup: true },
  }),
  encryption: { key: process.env.INTEGRATION_ENCRYPTION_KEY },
  auth,
  client: clientBundle,
  // Another process sends Events to POST /api/events with this key as a bearer token.
  events: { key: process.env.WFGRAPH_EVENTS_KEY },
  // The full extension surface, in one location.
  extensions: {
    events: [appointmentCreated],
    actions: [cancelAppointment],
    integrations: builtInIntegrations(),
  },
});

// wfgraph.fetch answers the API on /api/*. This call passes a client, so wfgraph.fetch
// answers the editor on /* too.
createServer(createRequestListener(wfgraph)).listen(3000);

// Raise an Event from your own code. The worker loop in this process starts the runs.
await wfgraph.events.send(appointmentCreated, {
  appointment: { id: "appt_123", startsAt: "2026-08-10T19:00:00.000Z" },
});
```

`examples/app.ts` is the same call with four Events and one custom action. That file is
correct. If this file disagrees with it, this file is wrong.

## Dynamic host action fields

Use `options` to supply application-owned choices for an input field. Each key must belong
to the input schema. A callback makes that field a picker; `configFields` remains available
for labels, ordering, and other presentation overrides.

```ts
const sendAppointmentMessage = defineAction({
  id: "appointments/send-message",
  label: "Send Appointment Message",
  description: "Sends a message using an application template.",
  category: "Appointments",
  input: z.object({
    templateId: z.string(),
    senderId: z.string(),
  }),
  options: {
    templateId: async () =>
      (await applicationTemplates()).map((template) => ({
        value: template.id,
        label: template.name,
      })),
    senderId: async ({ templateId }) =>
      templateId ? applicationSenderChoices(templateId) : [],
  },
  handler: async ({ input }) => sendAppointmentMessageFromTemplate(input),
});
```

For a variable shared by several template variants, declare the variable once in `input`
and add a list condition to its presentation:

```ts
configFields: [
  { key: "name", showWhen: { field: "template", in: ["a", "b"] } },
],
```

Here `input` declares both `template` and `name`. The editor offers `name` for templates
`a` and `b`, and hides it for `c`. Single-value `equals` conditions still work. See
[The config form](integrations.md#the-config-form) for matching and stored-value behavior.

Each callback receives the current draft as optional strings keyed by the input schema.
These are raw editor values, before schema decoding. Empty values and unresolved template
references are omitted. Return an array of `{ value, label }` choices directly or through a
Promise; an empty array means there are no choices for the current draft.

Workflow Graph refreshes choices when the draft changes and ignores responses for older
selections. A successful response clears a selected literal value that is no longer among
the choices. Loading, failed requests, and unavailable answers leave selections intact, as
do template references.

Callbacks are application-scoped and receive no Connection or credentials. Their
implementation stays on the server. Workflow Graph calls them for picker guidance only.
Callback failures show an inline fallback and do not themselves block Publish. Fields marked
required by the input schema retain normal blocking validation when empty. Draft
persistence, Run and Publish preflight, and action execution do not call these callbacks.

For an expected refusal, a callback can return
`{ status: "unavailable", reason: "not_permitted", message: "Ask an administrator for access to templates." }`.
The other reasons are `"unreachable"` and `"refused"`. An exception produces a generic
fallback without exposing the exception text.

## Mounting on Node

A fetch-native Node runtime takes `wfgraph.fetch` as it is:

```ts
Bun.serve({ port: 3000, fetch: wfgraph.fetch });
```

Express and Fastify speak `IncomingMessage` and `ServerResponse`.
`createRequestListener` does that translation.

```ts
const app = express();
// Mount Workflow Graph before each body parser. Pass the same path as basePath.
app.use("/workflows", createRequestListener(wfgraph));
app.use(express.json());
```

```ts
const app = Fastify();
await app.register(middie); // @fastify/middie, which runs in the onRequest hook
app.use("/workflows", createRequestListener(wfgraph));
```

Two failures the adapter handles for you:

- Express strips the matched path from `req.url`, so the adapter reads `req.originalUrl`.
  It logs once when the mount path and `basePath` disagree.
- A body parser in front of Workflow Graph drains the request. Workflow Graph cannot rebuild the original
  bytes that a connection webhook verifies its signature over. Such a request gets a 500 that
  names the fix.

## The editor

Pass the bundle and the editor turns on:

```ts
import { clientBundle } from "@wfgraph/client";

const wfgraph = await createWfGraphApp({ client: clientBundle, ... });
```

- Omit `client` and Workflow Graph answers 404 outside `/api`. That suits a host that puts the editor
  elsewhere, or drives workflows with Events alone.
- The option takes a directory that holds an `index.html`, so a custom build of the editor
  is the same call with a different bundle.
- Each of the two packages is independent of the other.

### Workspaces and Canvas Reveal

The editor shows a workflow on one canvas in three workspaces. **Draft** edits the
workflow, **Runs** inspects its runs, and **Changes** compares the draft with a published
version. Canvas Reveal is a panel that floats over the right side of the canvas at one of
two open levels. In Draft, selecting an object on the canvas opens Canvas Reveal. In Runs
and Changes, the first visit opens Browse, pressing a step on a run's canvas opens Focus,
and otherwise Canvas Reveal keeps the level the person last chose. Browse summarizes the
object, and Focus holds its complete editor, a run node's evidence, or its field-level
differences. On a canvas 1024px or wider, a person can drag the panel's left edge, or focus
that edge and use the arrow keys, to resize Browse and Focus. The browser remembers each
width in a cookie, and double-clicking the edge restores the default width. Cmd+B or
Ctrl+B opens and closes Canvas Reveal when it has an object to show, which in Draft means a
selected object. On a screen narrower than 768px, the shortcut closes the open sheets.
Opening, changing, or closing it moves the camera and leaves the saved draft unchanged.

The editor keeps the workspace address in the page's query string: `view` (`runs` or
`changes`, absent for Draft), `executionId`, `compare` (the base version id), and `group`.
Browser Back and Forward move between those addresses, and a copied link opens the same
run, comparison, or Group. Draft, each run, each comparison, and each entered Group keep
their own selection, Canvas Reveal level, scroll position, and camera while the page is
open.

### Groups

A Workflow Builder groups two or more steps with **Group** in the canvas context menu or
**Group selection** in the command palette. A Group organizes the canvas and leaves every
run unchanged: the engine walks the same stored edges whether or not a step sits in a
Group, and a Group writes no run log, result, or retry of its own. The workflow canvas
shows a Group as one collapsed card, and entering the Group opens a canvas of its members.
A connection dragged from the card's one outlet keeps the Group's existing continuation
ports. If nothing leaves the Group yet, it connects from each terminal non-Condition step.
Unused Condition outlets stay unwired: a False branch with no steps ends the path and
does not run the step after the Group. If only unused Condition outlets remain, open
the Group and choose a branch to continue. Deleting the card's outgoing connection
deletes each stored edge it represents. On an entered Group's
canvas a Workflow Builder adds, pastes, duplicates, connects, disables, and deletes steps,
and a step added, pasted, or duplicated there becomes a member of that Group. Members
keep their stored positions and can be dragged. **Tidy layout** arranges the entered
Group's members in one undoable edit without moving its frame or outside steps.
**Add step after** inserts a step between the chosen outlet and its existing targets;
dragging an outlet into empty canvas creates a branch with no automatic rejoin.
To change which branch continues, use the entered canvas: each edge to a
"Continues to" stub can be deleted on its own, and dragging from a step onto a "Continues
to" stub connects that step alone to the outside step the stub names.
In **Runs** the card shows the Group's run status and step counts. In **Changes** Group
edits count as Organization changes, and the comparison says when a version changes
nothing a run executes.

Version 1 Groups follow these rules:

- A draft save refuses a Group that holds the Lifecycle Node, an Add node, or another
  Group, and refuses a stored edge that touches the Group frame itself.
- Publish refuses a Group with fewer than two steps or with an Event Split inside it.
- Publish refuses a Group entered from more than one outside outlet. One outlet may
  connect to several steps inside the Group.
- Publish refuses a Group that continues outside from more than one inside outlet when
  those outlets reach more than one outside step. Several inside outlets that all connect
  to the same outside step and target handle are one continuation. A single continuing
  outlet may be one branch of a Condition whose other branch ends inside the Group.
- Publish refuses a join inside a Group with a branch from outside it, and a Condition in
  a Group on a branch into any join.

A draft that breaks a Publish rule still saves, and a draft run still starts, because the
rules do not change what a run executes. The editor forms a Group only from a selection
that meets the rules, and refuses a connection that would enter a Group from a second
outside outlet, continue a Group to a second outside step from several outlets, or break a
join rule. A connection that would create a cycle is refused before saving.
A refused connection, step, paste, or duplicate changes nothing and shows the
reason.

A Group frame's config is empty. Graph decoding refuses every Group config key, including
`direction`, `entryNodeIds`, `exitNodeIds`, and `outletHandle`. A draft or published version
that stores any of those keys fails to load; this release ships no migration for them.

### On a phone

Below 768px wide, Draft, Runs, and Changes show a sequence of sheets over a full-screen
canvas in place of Canvas Reveal. A Workflow Builder there can inspect every object, edit
the configuration of an existing step, run, publish, undo, and redo, as their grants
allow. The graph's shape cannot be edited on a phone: steps cannot be added, moved,
deleted, pasted, duplicated, grouped, or ungrouped, and connections cannot be drawn.
An entered Group uses the same stored member positions on a phone as on desktop.

## Authentication and authorization

The host owns operator sessions and policy. `auth` is a function of the request that returns
a request-scoped access policy, or `null` or `undefined` when the request is not signed in;
Workflow Graph neither receives nor stores a principal. Keep host identity, organization, and
grant state in the function's closure.

This is application capability authorization for the Workflow Graph surface. It is not
row-level ownership or tenant isolation: a granted operation can act on every Workflow Graph
record that operation addresses.

```ts
const wfgraph = await createWfGraphApp({
  // persistence, encryption, extensions
  auth: async (request) => {
    const session = await readSession(request);
    return session ? WfGraphRoles[session.role] : null;
  },
});
```

A function written in a module of its own takes its types from `defineWfGraphAuth`, which
returns the function unchanged, or from a `WfGraphAuth` annotation:

```ts
import { defineWfGraphAuth, WfGraphRoles } from "@wfgraph/core";

export const auth = defineWfGraphAuth(async (request) => {
  const session = await readSession(request);
  return session ? WfGraphRoles[session.role] : null;
});
```

`auth` also takes an object holding the function as `authenticate`. `createWfGraphApp`
refuses any other value at startup, with a message naming the option.

The `readSession` function represents your host's session adapter. A provider such as Clerk
can supply the user ID, organization ID, and role through that adapter. Load any remote grant
state once in this callback, then return `WfGraphAccess.fromPermissions(grants)` or
`WfGraphAccess.fromOperationIds(operationIds)`. Both constructors copy the collection into a
local immutable policy. Do not put a policy-store query inside `allows`.

`WfGraphRoles.viewer`, `.editor`, and `.admin` are directly usable immutable policies. The
viewer can read workflows, runs, and connections. The editor adds workflow changes, run
management, and the build agent. The admin allows every operation, including connection
management. Return `WfGraphAccess.all` when every authenticated session should have
unrestricted access; there is no implicit allow-all mode.

An access policy exposes `allows(operation)` and may return a boolean or `Promise<boolean>`.
Use the common role policies first, permission collections for custom roles, and exact
operation-ID collections only for advanced action-specific policy. An operation is one
protected server action such as `workflow.publish`; its permission is the broader capability such as
`workflow.write` that commonly grants several operations.

Workflow Graph passes a clone to authentication, so reading its body cannot drain the request
handled downstream. Authentication should normally use only session headers and cookies.

An operation is a frozen `WfGraphOperation` value with two fields:

- `id` is the stable business-action ID, such as `workflow.publish` or `oauth.start`.
- `permission` is the broader grant that commonly covers the operation, such as
  `workflow.write` or `connection.write`.

Use the following static exports from `@wfgraph/core` or `@wfgraph/core/worker`:

| Export                | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `WfGraphPermissions`  | Named constants for every `WfGraphPermission` value                  |
| `WfGraphOperations`   | Named operation descriptors that contain an ID and permission        |
| `WfGraphOperationId`  | Union of every supported operation ID                                |
| `WfGraphOperationIds` | Array of every supported operation ID                                |
| `WfGraphAccess`       | `all`, `fromPermissions`, and `fromOperationIds` access constructors |
| `WfGraphRoles`        | Directly usable immutable `viewer`, `editor`, and `admin` policies   |

Workflow Graph's built-in permission vocabulary is fixed:

| Permission         | Covers                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `workflow.read`    | Reading workflows and version history                                                                                    |
| `workflow.write`   | Creating, editing, publishing, restoring, and deleting workflows, and loading the vendor options a workflow field offers |
| `run.read`         | Reading runs, logs, events, status, and migration preflights                                                             |
| `run.manage`       | Starting, canceling, deleting, resuming, and migrating runs                                                              |
| `connection.read`  | Reading connections                                                                                                      |
| `connection.write` | Creating, editing, testing, deleting, and authorizing connections                                                        |
| `agent.use`        | Using the build agent                                                                                                    |

The following table maps every operation ID to its permission:

| Permission         | Operation IDs                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow.read`    | `workflow.getAll`, `workflow.getById`, `workflow.subscribeList`, `workflow.subscribeDraft`, `workflow.getVersionHistory`, `workflow.getVersionUsage`, `workflow.compareVersion`, `workflow.getCurrent`, `workflow.getVersionGraph`  |
| `workflow.write`   | `workflow.create`, `workflow.update`, `workflow.delete`, `workflow.duplicate`, `workflow.publish`, `workflow.restoreVersion`, `workflow.saveCurrent`, `workflow.bulkLifecycle`, `action.configOptions`, `integration.configOptions` |
| `run.read`         | `workflow.getExecutions`, `workflow.getExecutionsGlobal`, `workflow.getExecutionLogs`, `workflow.getExecutionEvents`, `workflow.getExecutionStatus`, `workflow.previewMigration`                                                    |
| `run.manage`       | `workflow.execute`, `workflow.deleteExecutions`, `workflow.resumeWait`, `workflow.cancelExecution`, `workflow.migrateExecutions`                                                                                                    |
| `connection.read`  | `integration.getAll`, `integration.get`                                                                                                                                                                                             |
| `connection.write` | `integration.create`, `integration.update`, `integration.delete`, `integration.disconnectOAuth`, `integration.testConnection`, `integration.testCredentials`, `oauth.start`, `oauth.status`, `oauth.callback`                       |
| `agent.use`        | `agent.chat`                                                                                                                                                                                                                        |

The role policies contain these permissions:

| Role     | Permissions                                                                   |
| -------- | ----------------------------------------------------------------------------- |
| `viewer` | `workflow.read`, `run.read`, `connection.read`                                |
| `editor` | Every viewer permission, plus `workflow.write`, `run.manage`, and `agent.use` |
| `admin`  | Every exported permission, including connection writes                        |

Each RPC and REST operation carries one descriptor from `WfGraphOperations`. The OpenAPI
operation ID matches `WfGraphOperation.id`, and the `x-wfgraph-permission` extension contains
`WfGraphOperation.permission`.

Authentication and authorization failures have distinct status codes. If authentication
returns `null` or `undefined`, Workflow Graph returns `401 Unauthorized`. A lookup such as
`WfGraphRoles[session.role]` that finds no role therefore answers 401. If `allows` returns `false`, the
operation returns `403 Forbidden`. A thrown or rejected callback, malformed access policy, or
non-boolean `allows` result is a host-system failure: Workflow Graph logs its details server-side
and returns a sanitized `500 Internal Server Error`.

Pass `auth: trustWfGraphUpstream()` only when an upstream component authenticates operators
and authorizes every operator request before it reaches Workflow Graph. This explicit policy
allows every Workflow Graph operation and does not create synthetic identity state.

Three route classes have different authorization behavior:

- Operator routes authenticate through the host. Protected RPC, REST, and OAuth operations
  call the returned policy's `allows` method.
- Machine routes bypass host authentication because they carry a credential of their own:
  a vendor signature or the app's events key. These routes are connection webhook intake
  and `POST /api/events` when `events.key` is set.
- The OAuth client metadata endpoint is public provider-discovery data and bypasses host
  authentication.

Operator routes refuse a write that a browser sends from another site, before host
authentication runs. A `POST`, `PUT`, `PATCH` or `DELETE` to the RPC, REST or OAuth routes
answers `403` when its `Sec-Fetch-Site` header is `cross-site` or `same-site`, unless its
`Origin` header equals the configured `publicUrl` or the origin the request was addressed
to. A request carrying `Origin` but no `Sec-Fetch-Site` is held to the same two origins. A
request carrying neither header is a non-browser client and passes to host
authentication. The rule covers a form posted from a sibling subdomain, which a
`SameSite=Lax` session cookie does not stop, and any site when the cookie is
`SameSite=None`. Machine routes and the MCP endpoint are outside the rule, and
`POST /api/integrations/oauth/start` also requires `Content-Type: application/json`.

A request body to the RPC, REST or OAuth start routes may be at most 8 MiB, which holds a
500-node workflow save. A larger body answers `413` before any handler reads it. Webhook
intake, `POST /api/events` and the MCP endpoint are held to 1 MiB.

The authenticated, boot-blocking `GET /api/extensions` response contains an
`authorization.operationIds` snapshot beside `catalog` and `agent`. Workflow Graph evaluates
every canonical `WfGraphOperation` through `allows` concurrently to build the snapshot. A
policy failure makes bootstrap fail with a 500; it never becomes an empty grant set. The editor
decodes the snapshot before its first render, then uses the granted IDs synchronously to hide
or disable controls and to skip queries for unavailable features. A response that omits the
authorization envelope or contains an unknown operation ID fails editor startup as a contract
mismatch.

The grant snapshot lasts for the page lifetime. Reload the page after an account or policy
change. The snapshot controls the editor experience only. Every protected RPC, REST, and OAuth
operation calls `allows` once again when the operation runs. A custom asynchronous policy must
therefore tolerate concurrent bootstrap calls. The built-in roles and collection policies are
local and perform no asynchronous fanout.

## MCP authoring

Set `mcp: true` to expose the authenticated Model Context Protocol (MCP)
authoring endpoint for localhost development. For a deployed host, configure
the hostnames that can address the endpoint:

```ts
const wfgraph = await createWfGraphApp({
  // ...
  mcp: {
    allowedHostnames: ["workflows.example.com"],
    allowedOriginHostnames: ["console.example.com"],
  },
});
```

The endpoint is `${basePath}/api/mcp`. With the default `basePath`, the endpoint
is `/api/mcp`. The `mcp` option is disabled by default and works with
`createWfGraphApp` and `wfWorker`.

List hostnames only, with no scheme or port. Every request must have an allowed
`Host` header. Browser requests must also have an allowed `Origin` hostname.
Requests from non-browser MCP clients can omit the `Origin` header. Workflow
Graph rejects an invalid host or origin with HTTP 403 before reading the body.

The endpoint supports only MCP protocol revision `2026-07-28`. Each `POST`
request contains one independent JSON-RPC message. Each request must set the
`MCP-Protocol-Version` and `Mcp-Method` headers, and include the client identity
and capabilities in request `_meta`. A `tools/call` request must also set the
`Mcp-Name` header. The endpoint doesn't support initialization, transport
sessions, `Mcp-Session-Id`, `GET` streams, or `DELETE` session termination.

Call `list_workflows` to list the workflows available through the host's
workflow list. The result contains workflow IDs and summary metadata. It omits
workflow graphs and integration credentials.

Call `create_workflow` with a required `name` and an optional `description` to
create a draft containing the default Lifecycle Node. The result contains only
`workflowId` and `draftRevision`. Use those values with the workflow authoring
tools. Creation is not idempotent. Do not automatically retry a creation request
when the result is unknown.

The remaining MCP tools read or edit an existing workflow draft. Each tool call
requires a `workflowId`. Read tools return the persisted `draftRevision`. Write
tools also require `expectedDraftRevision`, using the revision returned by the
most recent read or write. A successful write increments the revision once and
returns the new value.

A stale write returns an error tool result with code
`workflow_draft_stale` and the stored `draftRevision`. Call `read_workflow`
again, evaluate the edit against the returned graph, and then send a new write
with the updated revision. Don't automatically repeat the stale mutation.

Host and Origin validation protects the HTTP boundary from DNS rebinding. The
host authentication callback authenticates the caller. MCP tool calls use the
following operation grants:

- `list_workflows` requires `workflow.getAll`.
- `create_workflow` requires `workflow.create`.
- Every workflow-specific tool requires `workflow.getById`.
- Graph-writing tools also require `workflow.update`.
- `list_integrations` also requires `integration.getAll` because the result
  contains Connection IDs.

The authoring tools expose integration types and Connection IDs. They don't
return or decrypt integration credentials.

The MCP authoring surface supports draft creation and existing-draft edits. The
unavailable operations are duplicate, restore, delete, run, and publish. MCP
writes change the editable draft and leave the published workflow version
unchanged.

MCP tools read Group membership and keep existing Groups valid. `read_workflow`
reports each step's `groupId` and each Group's `memberIds`. The tools cannot
create a Group or ungroup one, and `delete_node` refuses
a Group frame. When a write leaves a Group with fewer than two steps, the server
ungroups it and the tool result names the Group. The build agent in the editor
uses the same tools and follows the same rules.

An open editor subscribes to persisted draft revisions through an authenticated
server-sent events (SSE) stream. The server checks the persisted revision twice
per second and emits an event only when the revision increases. After an MCP
write succeeds, a clean Draft canvas loads the saved graph and fits it into
view. The subscription reconnects from the last received revision after a
connection failure. A workflow created through MCP appears in the dashboard and
workflow switcher within one second.

If the browser has unsaved edits when the persisted revision changes, the
editor preserves those edits and shows **Draft changed elsewhere**. Select
**Reload agent edits** to discard the browser edits and load the persisted
draft.

## Built-in integrations

The third-party SDKs stay in `@wfgraph/plugins`. Pass them and they turn on:

```ts
import { builtInIntegrations } from "@wfgraph/plugins";

const wfgraph = await createWfGraphApp({
  // ...
  extensions: {
    integrations: builtInIntegrations({
      slack: {
        oauthClient: {
          clientId: process.env.SLACK_CLIENT_ID,
          clientSecret: process.env.SLACK_CLIENT_SECRET,
        },
      },
    }),
  },
});
```

Resend and PostHog OAuth use a public client metadata document and need no provider secret.
Slack OAuth needs the client ID and client secret of a registered Slack app. Omit
`slack.oauthClient` to keep Slack manual-only. All three integrations keep their manual
credential forms when OAuth is available.

OAuth requires `publicUrl`, which names the external origin alone. Workflow Graph
combines that origin with `basePath` to build exact callback and metadata URLs.
Use HTTPS outside loopback development. The callback remains behind `auth`, so
browser-based authentication must accept the provider's top-level redirect. A
`SameSite=Lax` session cookie satisfies that requirement; an authorization check
that depends on a custom request header does not.
Expose these routes at the resulting API path:

| Route                                                  | Caller and authorization                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `POST /api/integrations/oauth/start`                   | The operator's browser for create and reconnect. Uses the host `auth` check    |
| `GET /api/integrations/oauth/attempts/:attemptId`      | The originating operator browser. Uses the host `auth` and binding cookie      |
| `GET /api/integrations/oauth/callback`                 | The operator's browser after the provider redirect. Uses the host `auth` check |
| `GET /api/integrations/oauth/clients/:integrationType` | The OAuth provider. Public, read-only client metadata                          |

The start route stores a short-lived browser-bound attempt without creating a new
connection row. The callback claims it once and records a durable terminal result; the
status route lets the originating browser observe that result. A successful create
inserts the connection in the same transaction that records success, while a reconnect
updates the existing row through its revision fence. The typed
`integration.disconnectOAuth` RPC procedure handles disconnects. OAuth tokens stay in
the encrypted connection configuration and don't enter the extension catalog or RPC
responses.

`integration.delete` always removes a connection that holds an OAuth grant, including one
whose grant needs reauthorization. It asks the provider to revoke the grant first, and
answers `oauthRevocation: "revoked"` or `"not_revoked"` beside `success`. `not_revoked`
means revocation failed or could not be attempted, because `publicUrl` is unset, the
integration no longer declares `oauth`, or the stored grant is unreadable. The server logs
a warning naming the reason, and an operator revokes the grant at the provider.

- Clerk, Linear, PostHog, Resend, and Twilio are exported as values. Slack is a factory because
  it accepts host-provided OAuth client credentials.
- The editor shows what the server assembled. The action selector lists exactly the
  integrations you passed, and a connection can be stored for those alone.
- That list controls what reaches `createWfGraphApp`. The process still loads every SDK the
  package imports: two of the six carry one, and `@wfgraph/plugins` imports all six
  integrations. The static import buys the timing of a failure. A missing SDK stops the
  application at start-up, where a lazy import would let a single run fail much later.
- `@wfgraph/plugins` peer-depends on `@wfgraph/core`. Keep one core copy so the
  plugin definitions and the app share one runtime contract.

## Persistence

`createWfGraphApp` takes one opaque `persistence` value. The backend owns its
connection lifecycle, schema, migrations, queries, and transaction semantics.

For PostgreSQL 15 or newer, pass `wfPostgres`:

Pass a `url`, or pass the separate fields. Use one form only. A mixed value fails to
compile, and Workflow Graph refuses the same mixture at runtime.

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

The separate fields reach postgres.js as fields, so a database name with a space, an IPv6
host, a unix-socket host, and `ssl` all work.

**`schema`** names the Postgres schema that holds Workflow Graph. The default is
`_workflows`. Workflow Graph declares the tables unqualified, and the `search_path` of the connection
puts them in place, so the schema name is a runtime option. Drop that one schema and Workflow Graph
leaves the database, migration journal included.

Three rules follow. Each fails loudly:

1. A schema name must be an unquoted lowercase identifier of 63 characters or less.
   `search_path` folds other letters to lowercase, and Postgres truncates a longer name.
2. A `url` must carry no `search_path` query parameter. That parameter reaches the start-up
   packet and outranks the option.
3. The connection must keep that start-up parameter. Behind PgBouncer, set
   `track_extra_parameters=search_path` (1.22 or later). A session-mode connection or a
   direct connection keeps it too.

`docs/adr/0005` gives the reasons and the guards.

For native Node SQLite:

```ts
import { wfSqlite } from "@wfgraph/core/sqlite";

const wfgraph = await createWfGraphApp({
  persistence: wfSqlite({ filename: "./wfgraph.db" }),
  // auth, encryption, extensions
});
```

`wfSqlite()` with no options uses an in-memory database. Its workflows, runs,
and integrations disappear when the app is disposed or the process exits.
Pass `filename` when the data must survive a restart:

```ts
persistence: wfSqlite(); // ephemeral
persistence: wfSqlite({ filename: "./wfgraph.db" }); // persistent
```

SQLite creates and migrates its own normalized tables when it opens. One Workflow
Graph process owns a SQLite file, and its app runs the only worker loop on it, so
`runner: false` and `createWfGraphRunner` are refused on SQLite. Other connections
may still write to the file, such as your own transaction inserting into the event
inbox, or a backup tool. Every Workflow Graph write takes `BEGIN IMMEDIATE`, so its
concurrency decisions and wait claims stay atomic beside those writers, and a write
that finds the file locked waits `busyTimeoutMs` before it fails:

```ts
persistence: wfSqlite({ filename: "./wfgraph.db", busyTimeoutMs: 10_000 });
```

`busyTimeoutMs` defaults to 5,000 and must be a non-negative integer. SQLite is the
embedded option; PostgreSQL is the option for a host that runs Workflow Graph in
more than one process.

Workflow Graph adopts SQLite schema versions 6 and 7 into its Drizzle migration
journal without rewriting application tables. To retain data from a version 1–5
file, open the file with an earlier Workflow Graph release before upgrading. It
refuses a journal from a newer release or a physical schema that does not match
the journal instead of attempting a downgrade or repairing altered tables.

## Workflow runs

`createWfGraphApp` executes workflow runs in your application's process. A worker loop
claims each run that is due from the database that `persistence` names, runs it until it
finishes or until each of its branches is parked at a Wait, and records each completed step
in that database. A parked run is due again when the Wait's deadline passes, or when an
Event, a Cancel, an Exit, or a Migration resolves the Wait.

Every Event arrives in the `workflow_event_inbox` table, and the worker loop delivers it:
it opens the runs the Event starts, cancels the runs it cancels, and wakes the Waits it
matches. An Event reaches the inbox through `app.events.send`, `POST /api/events`, a
Connection's webhook, or an insert your own transaction makes. A host on Inngest keeps
`inngest.send` by registering the forwarders from `@wfgraph/core/inngest` on its own
Inngest `serve` or `connect`; each forwarder sends the Inngest event in with `events.send`.
For how to send one, see `docs/events.md`.

An inbox row stays after its delivery settles, as `delivered`, or as `failed` with the
reason in its `error` column. The loop deletes settled rows once they are older than
`events.retentionMs`, seven days by default, and never deletes a row still waiting for
delivery. See Keep settled Events for a window.

The loop keeps its state in two tables beside the other Workflow Graph tables.
`workflow_execution_schedule` holds one row per run in flight, and
`workflow_execution_steps` holds the result of each completed step, including what an
action returned. A run's rows in both tables are deleted when the run ends, so the tables
hold only runs in flight. Your database's backups and access controls cover them.

### Configure the runner

The `runner` option controls the loop:

- To run one loop with the persistence backend's defaults, leave `runner` out.
- To change some of the defaults, pass an object. A field you leave out keeps its default.
- To run no loop in a process, pass `false`. Use it for a process that only serves requests,
  beside processes that run `createWfGraphRunner` (see Run the loop in its own process). At
  least one process connected to the same database must run a loop, or runs open and never
  advance. SQLite refuses `false` at startup, because the app that owns a SQLite file runs
  the only loop on it (see Persistence).

| Field                 | PostgreSQL default | SQLite default | Description                                                                                |
| --------------------- | ------------------ | -------------- | ------------------------------------------------------------------------------------------ |
| `concurrency`         | 5, from the pool   | 1              | How many runs the loop advances at once. On PostgreSQL the default follows the pool size   |
| `deliveryConcurrency` | 1                  | 1              | How many Event deliveries the loop runs at once, in slots of their own beside the runs'    |
| `pollMs`              | 1,000              | 250            | How long the loop waits between checks for due runs when nothing wakes it, in milliseconds |
| `leaseMs`             | 60,000             | 60,000         | How long the loop holds a run before another loop can take it over, in milliseconds        |
| `heartbeatMs`         | 20,000             | 20,000         | How often the loop renews its hold while a step runs, in milliseconds                      |

Each field must be a positive integer, and `heartbeatMs` must be shorter than `leaseMs`.
`createWfGraphApp` refuses any other value at startup.

The loop claims runs, Event deliveries and cron schedule fires in three lanes. Runs and
deliveries are each limited by their own field, and fires take one slot. A delivery is the
work that starts, cancels and wakes runs for one Event, so a Cancel is applied while every
run slot is busy with a long step, and a schedule fires on time beside them. On PostgreSQL,
the passes of every lane share the pool with the app's HTTP requests, so the default
`concurrency` takes half of it: `min(10, max(1, floor(maxConnections / 2)))`, which is 5 for
the default pool of 10. The other half serves the delivery and cron lanes and the requests.
A `concurrency` you set is used as it is; give the pool a `maxConnections` above
`concurrency` plus `deliveryConcurrency` plus one when the app also serves requests from it.

```ts
const wfgraph = await createWfGraphApp({
  // auth, persistence, encryption, extensions
  runner: { concurrency: 20, pollMs: 500 },
});
```

### Keep settled Events for a window

`events.retentionMs` sets how long an inbox row is kept after its Event arrived, once its
delivery has settled. It defaults to 604,800,000, which is seven days, and must be a positive
integer of at most 100 years; a zero, negative, fractional or larger value fails at startup.
Once an hour, the loop deletes up to 500 `delivered` or `failed` rows that arrived earlier
than the window, beside its claims rather than ahead of them; when a sweep reaches that
limit, the next one runs a poll interval later. A `pending` row is never deleted.

The window is also the deduplication window. A send whose idempotency key matches a row
still kept is answered with that row and starts nothing, and once the sweep has deleted the
row, the same key is a new arrival. The `delivery_id` of an Execution names its inbox row
as plain text, so a run outlives the row it started from.

Every process that runs a loop sweeps with its own window: an app with its own loop, and
each `createWfGraphRunner`. Pass every one of them the same options object (see Run the
loop in its own process), or the process with the shortest window decides how long rows
are kept.

```ts
const wfgraph = await createWfGraphApp({
  // auth, persistence, encryption, extensions
  events: { retentionMs: 30 * 24 * 60 * 60 * 1000 },
});
```

### Delete run history after a window

Run history stays in your database until you ask Workflow Graph to delete it.
`runs.retentionMs` sets how long an ended run is kept after it completed, in milliseconds.
With no value, nothing is deleted.

With a value, the loop sweeps run history once an hour, in the same upkeep that deletes
settled inbox rows. Each sweep deletes up to 500 rows of each kind, in this order:

1. Executions that ended (`completed`, `failed`, `canceled`, `exited` or `superseded`)
   before the window. Each run's node logs, wait rows and timeline go with it.
2. Workflow audit rows that belong to no run, such as a Refused Start or a Cancel Event that
   reached no run, written before the window.
3. Draft snapshots that no remaining Execution references and that no Draft run has pinned
   since the window began. Each snapshot records in `last_pinned_at` when a Draft run last
   pinned it.

A run that an Event's delivery opened is kept while that delivery's inbox row exists, and so
is a Refused Start recorded for a delivery, however old either one is. A redelivered inbox
row is answered from the run or the refusal its first delivery recorded, so deleting either
one while the row can still be delivered again would open a second run. Once the inbox sweep
has deleted the row (see Keep settled Events for a window), the next run-history sweep
deletes the run or the refusal when it is past its own window. A run in flight is never
deleted, however long ago it started. Published versions are never deleted, so the version
history stays whole.

When any kind reaches its limit, the next sweep runs a poll interval later. A sweep the
database fails is logged, and the next try comes an hour later. Partial indexes on both
backends serve the sweep.

The value must be an integer from one hour (3,600,000) to 100 years, and startup refuses
anything else. A Draft run freezes its snapshot in one transaction and pins it with the
insert of its Execution in a later one, and the sweep keeps a snapshot reused between the two
only because the window is far longer than that gap. A window past 100 years would put the
sweep's cutoff out of the range a JavaScript `Date` holds.

Every process that runs a loop sweeps with its own window, as with `events.retentionMs`, so
the app and every `createWfGraphRunner` take the same options object. On a Cloudflare
Worker, the Cron Trigger's tick runs the sweep.

```ts
const wfgraph = await createWfGraphApp({
  // auth, persistence, encryption, extensions
  runs: { retentionMs: 90 * 24 * 60 * 60 * 1000 },
});
```

### Run the loop in its own process

`createWfGraphRunner` runs the worker loop in a process that serves no HTTP, so a host can
scale request handling and run execution separately. It takes the options object
`createWfGraphApp` takes. Build that object once, in a module both processes import, so the
database, the encryption key, the extensions and the retention windows cannot drift apart
between the two:

```ts
// wfgraph-options.ts
import type { WfGraphAppOptions } from "@wfgraph/core";
import { wfPostgres } from "@wfgraph/core/postgres";
import { builtInIntegrations } from "@wfgraph/plugins";
import { auth } from "./wfgraph-auth";
import { actions, events } from "./wfgraph-extensions";

export const options: WfGraphAppOptions = {
  auth,
  persistence: wfPostgres({ url: process.env.DATABASE_URL! }),
  encryption: { key: process.env.INTEGRATION_ENCRYPTION_KEY },
  extensions: { integrations: builtInIntegrations(), events, actions },
  // An OAuth token refresh in the runner builds its callback URLs from these.
  basePath: "/workflows",
  publicUrl: "https://app.example.com",
  // Tunes the runner's loop. The web process below runs none.
  runner: { concurrency: 20 },
};
```

```ts
// web.ts
import { createServer } from "node:http";
import { createRequestListener, createWfGraphApp } from "@wfgraph/core";
import { options } from "./wfgraph-options";

const wfgraph = await createWfGraphApp({ ...options, runner: false });
createServer(createRequestListener(wfgraph)).listen(3000);
```

```ts
// worker.ts
import { createWfGraphRunner } from "@wfgraph/core";
import { options } from "./wfgraph-options";

const runner = await createWfGraphRunner(options);
process.once("SIGTERM", () => void runner.dispose());
```

The runner serves no HTTP, so it ignores `auth`, `client`, `mcp`, `agent` and `events.key`,
and `auth` is optional for it. It always runs a loop: `runner: false` says that the app runs
none, so the runner ignores that value and runs its loop with the defaults, and a `runner`
object tunes the runner's loop as the table under Configure the runner describes. Every other
option means what it means on the app. The runner refuses SQLite at startup, because the app
that owns a SQLite file runs its loop.

`createWfGraphRunner` refuses `wfHyperdrive` at startup, because a Worker runs no
long-lived loop and advances its runs in the ticks of its `scheduled` and `queue` handlers.

It answers `{ events, dispose, [Symbol.asyncDispose] }`. `events.send` raises an Event the
way the app's does. `dispose()` drains the loop the way the app's does, then closes the
database. Run one Workflow Graph per process: an app and a
runner in the same process are not supported.

### How runs behave

- **A change wakes the loop in its own process at once.** When a service in your process
  writes a wake, such as an Event arrival or a Cancel, it wakes that process's loop
  directly. On PostgreSQL it also notifies the loops in other processes through `LISTEN`
  and `NOTIFY`. The poll finds Wait deadlines and any notification that was lost.
- **PostgreSQL loops in several processes share the work.** A claim locks the rows it
  takes with `SKIP LOCKED`, so two loops never advance the same run at once. When a process
  stops in the middle of a run, another loop takes the run over after its lease expires and
  resumes it from its last completed step.
- **SQLite runs workflows on your application's main thread.** `node:sqlite` is
  synchronous, so each statement blocks the event loop, and action handlers share that
  event loop with your HTTP requests. A loop on SQLite hears wakes from its own process
  only, so a run that another process makes due waits for the next poll.
- **A step that throws is retried.** Each step gets four retries, with a backoff that
  starts at one second and doubles up to one minute. A step that still fails fails its
  node, and the run's other branches continue.
- **`dispose()` drains the loop.** It stops claiming runs and waits up to ten seconds for
  the runs in progress. A run still in progress after that is released and resumes from its
  last completed step when a loop next claims it. The loop then logs `Worker loop stopped`
  with how many runs finished within the drain and how many were interrupted.
- **A loop that stops on an unexpected error starts again.** It logs the error and
  restarts after a backoff that starts at 200 milliseconds and grows to five seconds.
- **Drain in-flight runs before you upgrade from a release that ran workflows on Inngest.**
  A run that Inngest held has no row for the loop to claim, so it never advances. Let each
  run finish, or cancel it, before you upgrade.

`docs/adr/0021` records why runs execute in the application database.

## Cloudflare Workers and Hyperdrive

`@wfgraph/core/worker` runs Workflow Graph on a Cloudflare Worker with PostgreSQL through
Hyperdrive. A Worker invocation has no long-lived process for the worker loop, so the Worker
advances runs in ticks instead, and `createWfGraphRunner` refuses `wfHyperdrive`, so a Worker
deployment has no runner process. A tick claims the due runs and Event deliveries, runs each
one until it finishes or parks at a Wait, and returns. Three handlers share one default
export:

- `fetch` serves the API, as `createWfGraphApp` does.
- `scheduled` runs a tick for a Cron Trigger. Configure one that fires every minute.
- `queue` runs a tick when a run wake arrives on a Queue you configure. The Queue is
  optional.

```ts
import {
  wfHyperdrive,
  wfWorker,
  type WfGraphWakeQueue,
} from "@wfgraph/core/worker";

type Env = {
  HYPERDRIVE: { connectionString: string };
  WFGRAPH_WAKES: WfGraphWakeQueue;
  INTEGRATION_ENCRYPTION_KEY: string;
  WFGRAPH_EVENTS_KEY: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
};

export default wfWorker<Env>({
  publicUrl: "https://workflows.example.com",
  request: (env) => ({
    auth,
    persistence: wfHyperdrive(env.HYPERDRIVE),
    encryption: { key: env.INTEGRATION_ENCRYPTION_KEY },
    events: { key: env.WFGRAPH_EVENTS_KEY },
    wakeQueue: env.WFGRAPH_WAKES,
  }),
  extensions: (env) => ({
    events,
    actions,
    integrations: builtInIntegrations({
      slack: {
        oauthClient: {
          clientId: env.SLACK_CLIENT_ID,
          clientSecret: env.SLACK_CLIENT_SECRET,
        },
      },
    }),
  }),
});
```

The Wrangler configuration that matches this Worker:

```toml
compatibility_flags = ["nodejs_compat"]

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<your Hyperdrive configuration id>"

[triggers]
crons = ["* * * * *"]

[[queues.producers]]
queue = "wfgraph-wakes"
binding = "WFGRAPH_WAKES"

[[queues.consumers]]
queue = "wfgraph-wakes"
max_batch_timeout = 0

[limits]
cpu_ms = 300_000
```

`wfWorker` has one type parameter for the Worker environment. Host session state stays inside
the authentication callback and its returned access-policy closure.

### Worker options

`request` resolves bindings and secrets from the environment. `wfWorker` calls it once per
invocation of each handler, and it answers these fields:

| Field                | Required | Description                                                                                                                                  |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`               | Yes      | As on `createWfGraphApp`. Only `fetch` reads it                                                                                              |
| `persistence`        | Yes      | `wfHyperdrive(env.HYPERDRIVE)`, opened and closed once per invocation                                                                        |
| `encryption.key`     | Yes      | As on `createWfGraphApp`                                                                                                                     |
| `events.key`         | No       | Mounts `POST /api/events`, as on `createWfGraphApp`. A blank value, or one holding whitespace, fails the invocation before persistence opens |
| `events.retentionMs` | No       | How long a settled inbox row is kept, as on `createWfGraphApp`. Each Cron Trigger tick sweeps with it                                        |
| `runs.retentionMs`   | No       | How long an ended run is kept, as on `createWfGraphApp`. Each Cron Trigger tick sweeps with it. Unset, run history is never deleted          |
| `wakeQueue`          | No       | The Queue producer binding that carries run wakes. Its consumer must be this Worker. See Wake runs through a Queue                           |
| `agent`              | No       | As on `createWfGraphApp`                                                                                                                     |

The options passed to `wfWorker` itself are `basePath`, `publicUrl`, `entityResolverTimeoutMs`,
`mcp`, `logger`, and `extensions`, each as on `createWfGraphApp`. `extensions` also takes a
function of the environment.

`wfWorker` answers `{ fetch, scheduled, queue }`. A Worker that serves other routes, crons or
queues of its own calls these from its own handlers: `fetch(request, env, ctx)`,
`scheduled(controller, env)`, and `queue(batch, env)`. `fetch` hands the invocation's closes to
`ctx.waitUntil`, so a response is sent before the database connection closes. The `queue` handler treats every
message in a batch as a run wake, so route only the wake Queue's batches to it, by
`batch.queue`.

### Wake runs through a Queue

Without a Queue, the Cron Trigger's tick each minute is the only tick. An Event sent to the
Worker is delivered at the next tick, up to a minute later, and the runs it starts run in the
same tick.

With `wakeQueue`, a write a `fetch` invocation makes that makes a run or a delivery due also
sends a message, and the Queue starts the Worker's `queue` handler, which runs a tick. Such
writes include an Event's arrival, a Cancel, a manual resume, and a Migration. Each invocation
sends one message for the first such write, and one more for all the writes made while that
send was in flight. A message names no run, since a tick claims every due row. A tick sends no
message: a run that an Event's delivery starts is claimed by the same tick's next drain step. A
send the Queue refuses is logged, and the next Cron Trigger finds the run.

A Queue consumer waits up to `max_batch_timeout` seconds to fill a batch before it is invoked,
and Cloudflare's default is 5. Set it to 0, as in the Wrangler configuration, so a wake runs
its tick as soon as the message arrives. A wake carries no data, so a batch of one is as good
as a batch of ten.

The Cron Trigger is still required with a Queue. A Wait's deadline stays a row in the
database, which the Cron Trigger's tick finds, so a Wait resumes within a minute of its
deadline however long it waits; a Queue can delay a message by 24 hours at most. The Cron
Trigger's tick also claims a run whose invocation was cut short, and polls for the Events
your own transactions inserted.

### Ticks and the platform limits

A tick runs one run's pass at a time, beside one Event delivery's, on Hyperdrive's one
connection. It keeps claiming due rows until a claim finds none, so one tick works through a
backlog in turn. These limits apply to each tick:

- **Wall time.** Cloudflare ends a Cron Trigger or Queue consumer invocation after 15
  minutes. A tick claims new rows for its first 10 minutes and cuts any pass still running
  at 14 minutes. A cut pass hands its run back, due at once, and counts one failure against
  the step it was running, so a step that outlasts every tick spends its retries and fails
  its node instead of repeating its side effects on every tick. The next tick resumes the run
  from its last completed step. A tick returns at most 30 seconds after its budget, whether or
  not the cut passes' releases answered, and closing the database connection waits at most
  five seconds more. A claim or a poll the database has not answered when the budget runs out
  is abandoned.
- **Leases.** A tick holds each run it claims under a five-minute lease and renews it every
  minute while a step runs. When the platform ends an invocation before its tick can hand a
  run back, a later tick claims the run once its lease expires, about six minutes later at
  most.
- **CPU time.** Cloudflare counts CPU time across the whole invocation; time spent waiting on
  the database or on an action's requests is not counted. On the Paid plan a Queue consumer
  invocation gets 30 seconds by default, which `limits.cpu_ms` in the Wrangler configuration
  raises to at most 300,000 (five minutes), and Cloudflare's limits page lists 30 seconds for
  a Cron Trigger that fires more often than hourly. A tick stops claiming once it has run 100
  passes, which leaves each pass about 300 ms of CPU time in 30 seconds. A tick's record names
  its passes and why it stopped (`stopped: "pass_limit"`); the next tick takes the rest.
- **Statements.** Hyperdrive ends any statement after 60 seconds. Each statement a tick makes
  is short, and no transaction is held across a step.
- **Retention.** Only the Cron Trigger's tick runs the retention sweeps, of the inbox and,
  with `runs.retentionMs`, of run history, once a minute. A Queue tick does not, so it stays
  as short as the work its wake found.
- **Observability.** Each tick writes one record, `Tick finished` or `Tick failed`, grouped
  under `tick` with its trigger, its worker id (`cf-worker:cron:<id>` or
  `cf-worker:queue:<id>`, which is also written on each row it leases) and its duration, with
  its passes counted by kind and by result. A tick that fails to open the database, dies, or
  fails to close rethrows after its record, so a Queue retries the batch. The tick runs in a
  `wfgraph.worker.tick` span around the executor's `wfgraph.executor.tick` span.

A Durable Object per run, whose alarm fires at the run's next deadline, would give Waits a
resolution under a minute. Workflow Graph does not provide one. If ticks prove too slow for a
Worker host, the alternative recorded in `docs/adr/0021` is to run the engine on Cloudflare
Workflows for that backend.

### Hyperdrive

Each invocation opens and closes its own PostgreSQL client. Configure
the Hyperdrive binding with query caching disabled (`wrangler hyperdrive create` takes
`--caching-disabled`): Hyperdrive does not invalidate cached reads after Workflow Graph
writes. Set the PostgreSQL origin role's default `search_path` to put `_workflows` first (or
the `schema` passed to the factory); each invocation checks `current_schema()` and refuses a
mismatch. Apply PostgreSQL migrations outside the Worker with `@wfgraph/core/migrate`. Node.js
compatibility must be on: the runtime uses `node:crypto` and the PostgreSQL driver relies on
the Node compatibility APIs. A compatibility date of `2026-08-04` or later turns it on by
default; an earlier date needs the `nodejs_compat` flag.

## PostgreSQL migrations

Two entry points, one migrator.

**At start-up.** `wfPostgres({ migrations })` applies the pending
migrations before the HTTP server starts when `runOnStartup` is true (default
`false`). `migrationsDir` names a different source, resolved from the working directory. The default is the `drizzle/`
directory that `@wfgraph/core` ships, found relative to the running code. Workflow Graph reads the
working directory for that one option, so your own `./drizzle` is safe.

**From CI or a release step**, before an instance boots:

```ts
import { migrateWfGraphDatabase } from "@wfgraph/core/migrate";

await migrateWfGraphDatabase({
  url: process.env.DATABASE_URL!,
  // Or the separate fields. Add `schema` when Workflow Graph lives elsewhere.
  // `migrationsDir` sits here, flat, and takes no `migrations` key.
});
```

- It takes the same connection fields as `wfPostgres`, and it closes the
  connection on the way out, so a one-shot process exits when the promise resolves.
- Run it from several places at once. It holds a session-scoped advisory lock, and each
  caller that waits wakes to an already-migrated database.
- Call it inside a process that already built an application. The connection belongs to the
  call and is closed with it.

**Why this entry point alone applies the shipped SQL.** The files are schema-agnostic, and
`search_path` that selects the schema rides on the connection that Workflow Graph opens. `psql` or a
different migration tool puts the tables in `public`. This repository's
`pnpm run db:migrate` is the same entry with the environment read in front
(`scripts/migrate.ts`).

## Package exports

| Entry                    | What it is                                                                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@wfgraph/core`          | The host-facing entry. It exports the authoring vocabulary, application and authorization contracts, `createWfGraphApp`, `createWfGraphRunner` for a process that runs workflows and serves no HTTP, `createRequestListener`, and `callExternal` with `callExternalAsync` for a host action's HTTP calls |
| `@wfgraph/core/postgres` | `wfPostgres` for a Node PostgreSQL pool                                                                                                                                                                                                                                                                  |
| `@wfgraph/core/sqlite`   | `wfSqlite` for native Node SQLite                                                                                                                                                                                                                                                                        |
| `@wfgraph/core/worker`   | `wfWorker`, the Worker host with its `fetch`, `scheduled` and `queue` handlers, and `wfHyperdrive`, per-invocation PostgreSQL through Hyperdrive                                                                                                                                                         |
| `@wfgraph/core/plugin`   | What an integration package builds against                                                                                                                                                                                                                                                               |
| `@wfgraph/core/testing`  | `runAction`, `actionData` and `actionError`, for that package's own suite                                                                                                                                                                                                                                |
| `@wfgraph/core/migrate`  | `migrateWfGraphDatabase`, for migrations without an application                                                                                                                                                                                                                                          |
| `@wfgraph/core/logging`  | `configureWfGraphLogging`, the console setup a host installs                                                                                                                                                                                                                                             |
| `@wfgraph/core/inngest`  | `createWfGraphInngestFunctions`, the forwarders a host on Inngest registers so `inngest.send` reaches the event inbox. The one entry that imports `inngest`, an optional peer dependency. See `docs/events.md`                                                                                           |
| `@wfgraph/client`        | `clientBundle`, the built editor, passed to `createWfGraphApp` as `client`                                                                                                                                                                                                                               |
| `@wfgraph/plugins`       | Five static integration values, the configurable `slack(options?)` factory, and `builtInIntegrations(options?)`                                                                                                                                                                                          |
| `@wfgraph/plugins/ui`    | Their icons and output renderers as one record, imported by the browser alone                                                                                                                                                                                                                            |

Workflow Graph cannot serialize a React component, so that last record is the one part of the catalog
that stays off `/api/extensions`. `@wfgraph/shared` stays private, and the build inlines it
into whichever bundle needs it. `@wfgraph/core` and `@wfgraph/plugins` also include a
`skills/` directory in the tarball; it is not a package export.

`createWfGraphApp` is the Node host, and `createWfGraphRunner` is the Node process that only
runs workflows. `wfWorker` is the Cloudflare
Worker host: it serves the API and runs workflows on a Cron Trigger and an optional Queue,
while the platform's Assets binding or the application's router serves static files. See
Cloudflare Workers and Hyperdrive.

## createWfGraphApp options

| Option                    | Required            | Description                                                                                                                                                                                                            |
| ------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basePath`                | No                  | Path the host mounts Workflow Graph at (default `/`)                                                                                                                                                                   |
| `publicUrl`               | No                  | External HTTPS origin. Required for OAuth callback and client metadata URLs, and to copy a Connection webhook URL. Loopback development can use HTTP                                                                   |
| `auth`                    | Yes                 | A function of the request returning a request-scoped access policy, or `null` or `undefined` for a request that is not signed in. An object holding that function as `authenticate` also works                         |
| `persistence`             | Yes                 | A backend from `@wfgraph/core/postgres` or `@wfgraph/core/sqlite`                                                                                                                                                      |
| `entityResolverTimeoutMs` | No                  | How long one call to a `defineEntity` resolver may take, in milliseconds, as a positive integer. Defaults to 10,000. A timeout is an operational failure. See Current Entity State in `docs/events.md`                 |
| `encryption.key`          | With an integration | 64-character hex string that seals the integration credentials. Required when `extensions.integrations` declares one; an app with none may leave `encryption` out                                                      |
| `events.key`              | No                  | Shared secret that mounts `POST /api/events`. A sender presents it as `Authorization: Bearer <key>`. Unset, the route is not mounted. A blank value, or one holding whitespace, fails at startup. See `docs/events.md` |
| `events.retentionMs`      | No                  | How long a settled inbox row is kept after its Event arrived, in milliseconds, at most 100 years. Defaults to seven days. See Keep settled Events for a window                                                         |
| `runs.retentionMs`        | No                  | How long an ended run is kept after it completed, in milliseconds, from one hour to 100 years. Unset, run history is never deleted. See Delete run history after a window                                              |
| `runner`                  | No                  | The worker loop that runs workflows in this process. Omit it for the defaults, pass an object to tune it, or pass `false` to run none beside a `createWfGraphRunner` process. See Workflow runs                        |
| `extensions.events`       | No                  | `defineEvent` values                                                                                                                                                                                                   |
| `extensions.actions`      | No                  | `defineAction` values                                                                                                                                                                                                  |
| `extensions.integrations` | No                  | `defineIntegration` values                                                                                                                                                                                             |
| `agent.apiKey`            | No                  | OpenAI API key. Absent or blank turns the build agent off, and the editor then shows no chat panel                                                                                                                     |
| `agent.model`             | No                  | Model id the agent runs against. Defaults to a current OpenAI model                                                                                                                                                    |
| `agent.reasoningEffort`   | No                  | How hard the model thinks before answering: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Defaults to `medium`                                                                                        |
| `agent.baseUrl`           | No                  | An OpenAI-compatible endpoint that is not OpenAI's own                                                                                                                                                                 |
| `mcp`                     | No                  | Enables the authenticated stateless MCP authoring endpoint at `${basePath}/api/mcp`. Pass `true` for localhost development. For deployed hosts, configure allowed hostnames and origin hostnames. Disabled by default  |
| `health`                  | No                  | `true` mounts `GET /api/health`, the readiness route outside `auth`. Off by default. See API endpoints                                                                                                                 |
| `logger`                  | No                  | A `WfGraphLogger` that takes every record. See Logging below                                                                                                                                                           |
| `client`                  | No                  | The editor bundle to serve, from `@wfgraph/client`                                                                                                                                                                     |

Read these once:

- **`auth` protects operator routes.** It is a required option, so a call without it fails
  to type-check, and `createWfGraphApp` refuses a missing or malformed value at startup.
  Pass a function that resolves the session your application already uses and returns an
  access policy. Return `WfGraphAccess.all` for explicit unrestricted access, or
  pass `trustWfGraphUpstream()` when an upstream component enforces both checks. For the full
  contract, see [Authentication and authorization](#authentication-and-authorization).
- **Three route classes define exposure.** Operator routes use `auth`. The
  Connection-addressed webhook intake
  (`POST /api/webhooks/{type}/{connectionId}`) and Event intake
  (`POST /api/events`) are machine routes that carry their own credentials. The
  OAuth client metadata route is public discovery data. Webhook intake is always
  available outside the gate, and Event intake is available only when
  `events.key` is set. Workflow Graph applies the host authentication predicate
  route by route. Workflow Graph mounts no Inngest route: a host on Inngest
  registers the forwarders from `@wfgraph/core/inngest` on a route or connection
  of its own, and secures it with its own signing key.
- **Set `publicUrl` when an integration offers OAuth or a webhook.** Use the
  origin that a provider reaches, such as `https://workflows.example.com`. Put
  the mount path in `basePath`. Workflow Graph refuses a `publicUrl` that contains
  a path. Absent `publicUrl`, the editor cannot copy a webhook URL and says so
  rather than offering `window.location`.
- **A mount under a sub-path takes `basePath`.** Workflow Graph builds its API prefix, the
  `<base href>` of the SPA, and each asset URL from it. A host that mounts at `/workflows`
  and omits it gets a client that requests its assets from the root.
- **`hono` is a peer dependency**, at `^4.13.14`, and `inngest` is an optional one, at
  `^4.26.1`. Your application installs `hono` and owns its version; Workflow Graph builds
  its own Hono app inside, and `createWfGraphApp` answers with `fetch`, `basePath`,
  `events`, `health`, `dispose`, and `[Symbol.asyncDispose]` alone, so Hono appears nowhere in what
  it hands back. Only `@wfgraph/core/inngest` imports `inngest`, so install it only when
  you register the forwarders; your own Inngest client then shares the one SDK copy.
- `createWfGraphApp` answers
  `{ fetch, basePath, events, health, dispose, [Symbol.asyncDispose] }`. `events.send`
  raises an Event from your own code; see `docs/events.md`. `health()` is the check behind
  the readiness route; see API endpoints. For a
  lexical lifetime, declare the app with `await using`. For a long-running host, call
  `await dispose()` from its shutdown handler. Both forms run the same idempotent shutdown:
  they stop the worker loop and wait up to ten seconds for the runs it is advancing,
  finalize the Effect runtime, and close persistence. A host that registers the forwarders
  from `@wfgraph/core/inngest` can close that Inngest `connect` or route before disposing
  the app, which saves one retry. A forwarder that sends after dispose fails its step as a
  storage failure, Inngest retries the step on whichever process serves the forwarders
  next, and the event inbox stores the Event once because the retry carries the same
  Inngest event id. Either order loses no Event. One Workflow Graph per process remains
  the supported arrangement; each app owns its persistence instance, encryption key, and
  assembled surface.

## Logging

Workflow Graph logs through [LogTape](https://logtape.org) and configures none of it.
Every record it writes is under the `wfgraph` category, and where those records go is
the application's decision. A host that installs nothing gets silence, and
`createWfGraphApp` says so once at start-up.

Three ways to receive the records, in the order most hosts want them:

```ts
// 1. The console setup Workflow Graph ships. One call, before createWfGraphApp.
import { configureWfGraphLogging } from "@wfgraph/core/logging";

configureWfGraphLogging();
```

`LOG_LEVEL` names the level (default `info`), `LOG_FORMAT` picks `pretty` or `json`, and
with neither set an attached terminal gets `pretty` while a pipe gets one JSON object per
line. The call takes `level` and `format` as options for a host that would rather say so
in code.

The pretty layout writes one flush-left header line per record, then stacks the record's
fields below it in a small tree. A grouped field stays on one line as `key=value` pairs
while it fits, and opens into a row per member when it does not.
`LOG_PRETTY_PROPERTIES=off` drops the field lines, `LOG_PRETTY_INSPECT_DEPTH` sets how
deep the layout walks one field (default 3), `LOG_PRETTY_WIDTH` sets the column a group
has to fit inside (default `stdout.columns`, else 120), and `NO_COLOR` turns the ANSI
escapes off.

```ts
// 2. An application logger of your own, as one option.
const wfgraph = await createWfGraphApp({ logger: myLogger, ... });
```

A `WfGraphLogger` is any object with `info`, `warn`, `error` and an optional `debug`, each
taking a message and a field bag. Passing one installs a LogTape configuration and
replaces any other in the process, so a host with its own LogTape setup uses the third way
instead.

```ts
// 3. Your own LogTape configuration, with a sink for the wfgraph category.
await configure({
  sinks: { console: getConsoleSink() },
  loggers: [{ category: "wfgraph", sinks: ["console"], lowestLevel: "info" }],
});
```

`@wfgraph/core/migrate` writes through the same category, so a migration job that wants
its output calls one of the three first.

**A record is one unit of work.** One HTTP request writes one record naming the method,
the path, the status, the elapsed time, the RPC procedure it addressed and, when it was
refused, the reason. One node execution writes one record naming the node, what it ran,
how it ended and how long it took. Each pass of a run writes one record when it starts
and one when it ends, which says whether the run parked at a Wait or finished.
No payload is logged: a request body, a response body and an Event payload are all stored
where they can be read whole, and printing them buries the line beside them.

**Fields are grouped.** A record's fields arrive as objects by subject (`http`, `rpc`,
`run`, `node`, `outcome`, `error`) rather than flat. The pretty layout prints one line per
group. The JSON line puts each group at the top level of the object, so a log store
addresses `run.execution` and `http.status`.

## Tracing

Workflow Graph opens OpenTelemetry spans and starts no SDK, no exporter and no processor.
Each service call and each engine step opens its span on Effect's tracer, which is bridged
onto whichever provider `@opentelemetry/api` answers with. That provider is resolved once
per span, so a host may register before or after `createWfGraphApp`, and a host that
registers nothing gets no-op spans.

Every span name below is a stable contract, and all of them arrive under the
`wfgraph-workflows` instrumentation scope. Four come from the engine, one per unit
of work inside a run:

| Span                              | Opened for               | Attributes                                                                                           |
| --------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `wfgraph.workflow.execution`      | one pass of a run        | `wfgraph.workflow.id`, `wfgraph.workflow.name`, `wfgraph.execution.id`, `wfgraph.execution.run_mode` |
| `wfgraph.workflow.node.execute`   | each node                | `wfgraph.node.id`, `wfgraph.node.name`, `wfgraph.node.type`, and `wfgraph.action.type` on an action  |
| `wfgraph.workflow.action.execute` | the action inside a node | `wfgraph.action.type`, `wfgraph.node.id`, `wfgraph.node.name`                                        |
| `wfgraph.workflow.wait`           | a Wait node              | `wfgraph.wait.type` (`delay` or `event`), `wfgraph.node.id`, `wfgraph.node.name`                     |

Twelve more come from the services behind the API, one per request the editor or a
host makes. Each carries the identifiers it is about, and a span nested inside
another leaves the parent's identifiers to the parent rather than repeating them.
Where a call has a verdict worth reading, `wfgraph.outcome` names it in one machine
word:

| Span                                 | Opened for                                  | Attributes beyond the identifiers                                                                             |
| ------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `wfgraph.workflow.publish`           | minting a version from the draft            | `wfgraph.workflow.version.id` and `.number` on success; `wfgraph.outcome` is `published` or the conflict code |
| `wfgraph.workflow.publish_readiness` | the readiness battery, under a publish      | `wfgraph.outcome` is `ready`; a refusal leaves the span with the error recorded                               |
| `wfgraph.workflow.version.compare`   | a draft diffed against a version            | `wfgraph.workflow.version.base_id`                                                                            |
| `wfgraph.workflow.version.history`   | a page of the version list                  | none                                                                                                          |
| `wfgraph.workflow.version.restore`   | a version copied back to the draft          | `wfgraph.workflow.version.id`                                                                                 |
| `wfgraph.workflow.preview_migration` | the migration preflight over in-flight runs | `wfgraph.workflow.version.target_id`, `wfgraph.outcome`                                                       |
| `wfgraph.workflow.migrate_runs`      | moving the named runs to the target version | `wfgraph.workflow.version.target_id`, `wfgraph.outcome`                                                       |
| `wfgraph.execution.start`            | a manual run request                        | `wfgraph.execution.id` once a run opens; `wfgraph.outcome` is `running` or `ignored`                          |
| `wfgraph.execution.load_workflow`    | the published version a start reads         | `wfgraph.workflow.version.id`                                                                                 |
| `wfgraph.execution.load_draft`       | the draft snapshot a draft run creates      | `wfgraph.workflow.version.id`                                                                                 |
| `wfgraph.execution.preflight`        | the checks that version must pass           | `wfgraph.workflow.version.id`                                                                                 |
| `wfgraph.execution.cancel`           | cancelling a run                            | `wfgraph.outcome` is `canceled` or `already_finished`                                                         |

A service function outside that table opens a span named after the function
itself. Those names are internal and change with the code.

**An attribute is an identifier.** A workflow id, an execution id, a version id,
and one outcome word are the whole of it. A graph, a request body, an Event
payload, a step output and a credential are stored where they can be read whole,
and a trace backend shows an attribute to everyone who can read the trace.

**A Wait ends the trace.** A run executes in passes: a pass ends when every branch has
finished or parked at a Wait, and a later pass resumes the run when a Wait is resolved.
Each pass opens a root `wfgraph.workflow.execution` span of its own, because nothing
carries the trace context from one pass to the next.

### Sentry

`@sentry/node` puts its own tracer provider on the global OpenTelemetry API, which is the
one Workflow Graph's spans open on. Initialising Sentry is the whole of the trace setup:

```ts
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1,
  enableLogs: true,
});
```

Records reach the same trace through `@logtape/sentry`, which reads the trace and span ids
off whichever span is open when a record is written. Sentry's trace view then shows a run's
spans with each record on the node that wrote it.

```ts
import { configure } from "@logtape/logtape";
import { getSentrySink } from "@logtape/sentry";

await configure({
  sinks: { sentry: getSentrySink() },
  loggers: [{ category: "wfgraph", sinks: ["sentry"], lowestLevel: "info" }],
});
```

That is the third way from the section above rather than `configureWfGraphLogging`, because
one LogTape configuration owns the process. Name a console sink beside it to keep reading
the records locally.

### Any other backend

Register a provider on the global API and the spans follow it:

```ts
import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

new NodeTracerProvider({
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
}).register();
```

`OTEL_EXPORTER_OTLP_ENDPOINT` names the collector. Workflow Graph requests the
`wfgraph-workflows` instrumentation scope from the global tracer provider. The host's
`Resource` describes the service.

## API endpoints

The base path is `/api`, under whatever `basePath` names. Workflow Graph builds the full route list
from `packages/shared/src/rpc/contracts.ts` and serves it live:

- `GET /api/openapi.json` for the document
- `GET /api/docs` for the browsable form

### Readiness

`health: true` mounts `GET /api/health` for a load balancer or an orchestrator's readiness
probe. A load balancer cannot sign in, so the route answers outside `auth`, and its body
holds booleans and a timestamp alone:

```json
{
  "ok": true,
  "checkedAt": "2026-11-11T09:00:00.000Z",
  "database": true,
  "runner": true
}
```

- `database` is whether the database answered a read of one row by id within five
  seconds.
- `runner` is whether this process's worker loop finished a turn of polling and claiming
  within two poll intervals, and never less than a minute. It is `null` in an app created
  with `runner: false`.
- `ok` holds when both do, and the status is then 200; otherwise it is 503. The response
  carries `Cache-Control: no-store`, and its request record is written at the `trace`
  level, so a probe every few seconds stays out of the logs until it fails.

`app.health()` answers the same check with the time of the loop's last turn, for a host
that serves a health endpoint of its own. It never rejects. The route is off by default.
