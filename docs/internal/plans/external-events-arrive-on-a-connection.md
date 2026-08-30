# Integration-owned Events (webhook intake)

Proposed. Not started. Refined from "integrations should create triggers, which
requires receiving webhooks."

The word **trigger** is retired (CONTEXT.md, ADR-0007). This plan does not revive
`createTrigger`. An integration declares **Events**. A webhook is the intake
channel those Events arrive on. Lifecycle roles stay the Workflow Builder's.

## Problem Statement

How might we let a Slack message, a Linear issue, or a Clerk user event start
(or cancel, or wake) a workflow without the Event Author writing a webhook
receiver in the host?

Today only the host can raise an Event, by `inngest.send`. Integrations already
declare actions and hold Connections. They cannot declare vocabulary, and core
mounts no route a third party can POST to. The gap is why a Workflow Builder
can _send_ a Slack message from a graph and cannot _start_ that graph from one.

Success: a builder picks "Slack · Message posted" on the Lifecycle Node, picks
the Connection, publishes, and a real Slack event starts a run. The host wrote
no receiver.

## Recommended Direction

Treat this as two additive seams on machinery that already exists, not as a
new kind of node.

**1. An Event may belong to an integration.** `defineIntegration` takes
`events`, the same `defineEvent` values the host already writes. Assembly folds
them into the one catalog (`assembleExtensions` /
`packages/core/src/backend/extensions/extension-set.ts`). The editor lists them
beside host Events. Identity stays the Event name; ownership is
`EventMetadata.integration`, the way `ActionMetadata.integration` already
marks who owns an action.

**2. A webhook is an ungated intake channel that produces those Events.** Core
mounts it on `machineRoutes` (`packages/core/src/backend/api-app.ts`), next to
the Inngest serve path and wait-resume, because a vendor carries its own
signature rather than the host's `auth` predicate. `verify` then `receive` then
`inngest.send`. From that send onward, Precedence is unchanged: Lifecycle
Rules first, then Wait Subscriptions.

**Connection is delivery metadata, not payload.** Do not inject `_connection`
into Event data and do not use `source.when` to scope a workspace. `source.when`
is compiled at Event definition (Event Author), so using it for a Connection
would smuggle Workflow Builder policy into vocabulary, which is the split
ADR-0007 exists to keep. Carry the Connection id beside the Event name, on the
same CEL root the run already has (`event.name` in
`packages/shared/src/conditions/condition-model.ts` → `event.connectionId`).
The Lifecycle Node (and a Wait that parks on an integration Event) gets a
Connection picker, the same picker an action node already has.

Two intake bindings, because vendors do not agree on the grain of a URL:

| Binding              | URL                                                  | When                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection-addressed | `POST {basePath}/api/webhooks/{type}/{connectionId}` | The vendor lets the operator (or an API) set a unique Request URL per account. Linear, Clerk, Twilio status callbacks, Resend, a manual Slack app.                                                                                                                                                                     |
| Type-addressed       | `POST {basePath}/api/webhooks/{type}`                | One URL serves every Connection of that type. Slack Events API under a host-owned OAuth app: one Slack app, many workspaces, one Request URL. Lookup is by a **plaintext, indexed** `externalAccountId` on the Connection row (`team_id`), written at OAuth exchange / connection test, never by decrypting every row. |

The earlier rejection of "read `team_id` out of the payload" was right about
decrypt-all and wrong about the alternative. Store the account id in the
clear, the way a Connection already stores `id`, `name`, and `type`.

Prefer Connection-addressed. Add Type-addressed when the worked integration
needs it (Slack OAuth), not before.

## Why not the other directions

**Revive `createTrigger`.** The authored trigger dissolved because it had
nothing left to own once Events carried the Correlation Path and the builder
owned Concurrency. A webhook is an intake channel. Calling it a trigger
reopens ADR-0001.

**Per-workflow unique URLs (Zapier).** Slack's Events API is one URL per Slack
app, not per workflow. Two workflows on one workspace would not get two
deliveries. The Connection is the right grain; the Lifecycle Node is where a
workflow opts in.

**Polling.** Avoids a public URL. Worse latency, more vendor API cost, and not
what this idea asked for. Leave it for a vendor that has no webhook.

**Host still writes the receiver.** Integrations would only declare Events, and
Fountain (or every adopter) would still own Slack's signing secret, the
challenge handshake, and the mapping to Event names. That is the status quo
with extra catalog entries.

**Inngest's own webhook transforms.** Moves verification into Inngest Cloud
config the library does not own, and still leaves Connection routing unsolved.

## Key Assumptions to Validate

- [ ] A production embed has `publicUrl`. OAuth already requires it
      (`packages/core/src/backend/lib/http/public-url.ts`). The editor copies
      webhook URLs from the same origin. Loopback HTTP is enough for local Slack
      request-URL verification via a tunnel; document that, do not invent a second
      public-origin option.
- [ ] Workflow Builders can pick a Connection for an Event. They already pick
      one on every integration action. The Lifecycle Node is a new place, not a
      new idea.
- [ ] Vendors will POST to the adopter's origin. Self-hosted embeds behind
      firewalls are a real failure mode; the answer is the adopter's tunnel or
      ingress, not a Workflow Graph SaaS relay.
- [ ] One Event name per thing that happened is enough, with Connection as a
      delivery dimension. `slack/message.posted` is vocabulary; which workspace is
      not.
- [ ] Slack OAuth can wait. Manual Slack (operator's own app, signing secret on
      the Connection, Connection-addressed URL) proves intake without Type-addressed
      routing. Linear is the easier first vendor if Slack's handshake stalls the
      MVP.

## MVP Scope

Each phase ends green against the AGENTS.md check list.

1. **An Event may belong to an integration.** `defineIntegration` takes
   `events`. Assembly folds them through `indexEvents` and
   `assertDistinctListenerIds`. Catalog metadata gains `integration?: string`
   on `EventMetadata`. No route yet: a direct `inngest.send` of that name
   already starts a run. The editor can list Slack Events. This phase alone is
   visible.

2. **The Connection-addressed route.** One handler for every integration that
   declared `webhook`. Path params are type and connection id. Load the
   Connection, run `verify`, run `receive`, `inngest.send`. Statuses: 404
   unknown Connection or type; 401 bad signature; 400 body `receive` refuses;
   200 body it ignores; 200 Event sent. Handshake (Slack `url_verification`) is
   a first-class `verify`/`receive` answer that returns a Response and does
   not send. Add the path to `machineRoutes`.

3. **Connection on the run, not in the payload.** The send carries
   `connectionId` outside `data`. The listener threads it into delivery. A
   workflow that named a Connection on a Start Event, Cancel Event, or Wait
   matches only that Connection. Host Events have none, and a filter on
   Connection matches nothing for them.

4. **The picker.** On the Lifecycle Node, an Event whose metadata names an
   integration offers the Connection dropdown. Record the chosen id on the
   Lifecycle Rules (and on a Wait Subscription that parks on such an Event).
   Amendment to ADR-0007 once the field lands. Empty Connection means "any
   Connection of this type", which is the wrong default for a builder with two
   Slacks; prefer required once any Connection exists, and refuse Publish
   rather than silently fan in.

5. **One worked integration.** Linear if we want unique-URL-per-connection
   with an ordinary HMAC and no handshake. Slack if we want to prove
   handshake + signing secret on the Connection (manual app). Do not start
   with Slack OAuth (Type-addressed + `externalAccountId` + extra Events API
   scopes beyond today's `chat:write`).

`publicUrl` is required to copy a webhook URL in the editor, the way it is
required for OAuth callback URLs. Absent `publicUrl`, the integration still
defines Events; the copy-URL control says why it cannot.

## Not Doing (and Why)

- **Reviving trigger as a noun** — the Lifecycle Node already is the start
  surface; a second object would re-split ownership.
- **`_connection` as a reserved payload key** — it collides with the open
  intake gate, forces every Event schema to leave a key free, and tempts
  `source.when` into doing per-workflow work. Delivery metadata belongs next
  to `event.name`.
- **Decrypt-all or try-every-secret routing** — cost grows with Connections;
  an unsigned vendor stays unattributable. Index a plaintext account id
  instead, when Type-addressed routing is needed.
- **Active vendor subscription APIs in the MVP** (Linear `createWebhook`,
  Slack `apps.event.subscribe`) — paste-the-URL is enough to prove intake.
  Auto-register is a later Connection lifecycle hook.
- **Polling triggers** — different product, different runtime (cron +
  cursor). Out of scope.
- **Per-workflow webhook URLs** — wrong grain for Events-API vendors; the
  Lifecycle subscription index already decides which workflows care.
- **Changing Precedence, the engine's ports, or wrapping handler bodies** —
  the engine still imports neither the route nor the database. Intake ends at
  `inngest.send`.
- **Host Events growing a Connection** — they keep arriving by direct send
  with no Connection anywhere on them.
- **Type-addressed routing and `externalAccountId` in the MVP** — needed for
  Slack OAuth, not for proving the seam.

## The authoring shape

`defineIntegration` gains an optional `webhook`. Events stay `defineEvent`
values so payload gates, Correlation Paths, and `source.when` do not fork.

```ts
webhook: {
  verify: (request, credentials) => Effect<WebhookDisposition, SignatureRejected>,
  events: readonly AnyEventDefinition[],
  receive: (body, headers) =>
    | { event: string; data: JsonObject }
    | { handshake: Response }
    | undefined,
}
```

`verify` runs first, with the Connection named in the URL (Connection-addressed)
or with the integration's app-level secret (Type-addressed, later). `receive`
answers `undefined` for a payload this integration knows and this Workflow
Graph has no Event for: the route answers 200 rather than an error, so a vendor
retry storm does not follow a subtype we chose not to model.

Signing secrets are not always Connection credentials. Slack's signing secret
is an _app_ credential: on a manual Connection it is a new field; on host-owned
OAuth it lives next to `oauthClient`, not in the encrypted Connection row.
`verify` must be able to read that, or Slack OAuth verification is impossible
even after Type-addressed routing exists.

## What must not regress

- A host's own Events keep arriving by direct send with no Connection on them.
- Precedence is unchanged (CONTEXT.md).
- The engine still imports no route and no database.
- `auth` still does not consume the request body (`authorize.ts`). Webhook
  verification reads the body; that is why this path is a `machineRoute` and
  not a host-gated one.
- Never log a payload. A webhook body is a payload. Log type, Connection id,
  Event name, byte size.

## Open Questions

- **Required vs optional Connection on an integration Event.** Required-at-
  Publish is the safer default (two Slack Connections must not start each
  other's runs). "Any Connection of this type" is a real power-user case;
  decide before the picker ships.
- **Wait Subscriptions.** An integration Event that is not a Start Event still
  has to name a Connection, or a wait parked in workspace A wakes on workspace
  B. Likely the same picker, stored on the Wait config, defaulting to the
  Start Event's Connection when the run already has one.
- **Deleted Connection.** A published version still names it. Delivery should
  refuse that start the way a missing action fails a node, and record it,
  rather than silently fan in to every remaining Connection of the type.
- **Glossary.** If this ships, CONTEXT.md gains Integration Event (an Event
  whose owner is an integration) and Webhook intake (the ungated channel).
  Connection already exists. Do not add Trigger back.

## Phases (unchanged bar)

Each phase ends green. Run the full check list from AGENTS.md before every
commit. A change adopters install needs a changeset; this plan file does not.
