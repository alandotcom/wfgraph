# An external Event arrives on a connection

Proposed. Not started.

Goal: an integration can declare Events of its own, and one of them can start a workflow.
A Slack message wakes a WfGraph workflow without the host writing a webhook receiver.

An application may hold several connections of one integration type. Two Slack
workspaces are two connections, and one workspace's Event must never start the other's
run.

## What exists

**Many connections already work in storage.** `integrations` (`packages/core/src/backend/lib/db/schema.ts:64`)
gives each row an `id` and a `name`, and it declares no unique index on `type`. An action
node stores an `integrationId` and the handler reads it from its run context
(`packages/core/src/backend/extensions/define-action.ts`, `ActionBag.integrationId`).

**Events reach WfGraph through Inngest only.** An Event is a listener function built from
its definition (`packages/core/src/backend/lib/inngest/event-listener-function.ts`), and
the payload gate runs there (line 102). Core mounts no route that a third party can post
to. The host sends its own Events from its own code.

**An Event belongs to nobody.** `EventDefinition` (`packages/core/src/backend/extensions/define-event.ts`)
carries a name, a payload gate, a Correlation Path, and a source. It has no owner and no
place to record which connection a payload came in on. `WfGraphExtensions`
(`packages/core/src/backend/extensions/extension-set.ts:52`) takes `events` from the host
and `integrations` beside it, and an `IntegrationDefinition` holds credentials, a test,
and actions, with no events.

## The design

### The route carries the connection id

Mount one route per integration under the API app (`packages/core/src/app.ts:276`):

```
POST {basePath}/api/webhooks/{type}/{connectionId}
```

The operator pastes this URL into the other system. Each connection gets a URL of its
own, so the route knows the connection before it reads the body, and the signature check
has exactly one secret to use.

The two rejected alternatives, recorded so they are not revisited:

- **Read a key out of the payload**, such as Slack's `team_id`. The connection config is
  sealed into one AES string (`schema.ts:72`), so there is nothing to index and every
  connection of that type would have to be opened and decrypted per request.
- **Try each connection's secret against the signature.** The cost grows with the number
  of connections, and a vendor that signs nothing leaves the request unattributable.

### The integration describes intake

`defineIntegration` gains an optional `webhook`:

```ts
webhook: {
  verify: (request, credentials) => Effect<void, SignatureRejected>,
  events: [ ... ],          // the Events this integration declares
  receive: (body, headers) => { event: string, data: JsonObject } | undefined,
}
```

`verify` runs first, with the credentials of the connection named in the URL. `receive`
turns the accepted body into the Inngest event name and its data, and answers `undefined`
for a payload this integration knows and this WfGraph has no Event for, which the route
answers 200 rather than an error.

### The connection id travels in the event data

The route writes the connection id into the event data at one reserved path before it
calls `inngest.send`. Reserve `_connection`, and hold every Event's payload schema to
leaving that key free.

That path makes the existing machinery do the work:

- `source.when` (`define-event.ts`, `EventSource`) already filters an arriving payload by
  a path and an exact string. A workflow that must listen to one workspace only is a
  filter on `_connection`.
- The Lifecycle Rules read paths out of the payload the same way, so a Start Event
  scoped to one connection needs no new mechanism in `packages/shared/src/lifecycle/`.

### Open question: does a workflow name its connection

A Workflow Builder who has two Slack connections must be able to say which one starts the
workflow. Two shapes, and the decision belongs with the Lifecycle Rules work rather than
with intake:

- **A field on the Lifecycle Node.** The builder picks a connection beside the Start
  Event, and the fan-out adds the `_connection` equality itself. This reads well and puts
  the picker where the builder already is.
- **A plain payload filter.** The builder writes the match by hand against `_connection`.
  Nothing new is built, and the builder has to know the connection id.

Prefer the first. Record the decision as an amendment to ADR-0007 once it is made.

## Phases

Each phase ends green. Run the full check list from AGENTS.md before every commit.

1. **An Event may belong to an integration.** `defineIntegration` takes `events`.
   Assembly folds them into the same list the host's own Events go into, so
   `indexEvents` (`extension-set.ts:84`) already refuses a name collision and
   `assertDistinctListenerIds` already refuses an id collision. No route yet, so the
   Events are startable only by a direct send. This phase alone makes an integration's
   vocabulary visible in the editor.
2. **The route.** One handler for every integration, reading the type and the connection
   id out of the path, loading the connection, running `verify`, running `receive`, and
   sending. The failure cases are a 404 for an unknown connection, a 401 for a bad
   signature, a 400 for a body `receive` refuses, and a 200 for a body it ignores.
3. **The connection id in the data.** Reserve `_connection`, write it at intake, and
   refuse at assembly any Event whose payload schema declares that key.
4. **The picker.** Whichever shape the open question above settles on.
5. **One worked integration.** Slack, because its signature scheme is ordinary and its
   payloads are well documented. It proves the four phases above against a real vendor.

## What must not regress

- A host's own Events keep arriving by direct send with no connection anywhere in them.
  `_connection` is absent, and a filter on it matches nothing.
- Precedence is unchanged. The Lifecycle Rules apply first, then Wait Subscriptions, as
  CONTEXT.md states.
- The engine still imports no route and no database.
