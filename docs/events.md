# Defining Events and Entities

How an Event Author declares Events, current Entity State, umbrella sources, how an application sends an Event, including through Inngest, the intake gate, and how that fits the Lifecycle model.

An Event is a named payload shape that your application raises.

```ts
const paymentSettled = defineEvent({
  name: "billing/payment.settled",
  label: "Payment settled",
  description: "The billing service raises this Event when a charge clears.",
  schema: z.object({
    appointmentId: z
      .string()
      .describe("The appointment this payment belongs to."),
    amountCents: z.number().meta({
      title: "Amount",
      description: "The settled amount in cents.",
    }),
    settledAt: z.iso.datetime(),
  }),
  correlationPath: "appointmentId",
});
```

The lifecycle role of an Event belongs to the editor. Each Workflow Builder declares there
which workflow it starts and which it cancels (`docs/adr/0007`).

`defineEvent` builds a value. Pass it in `extensions.events`, where assembly checks it and
names the Event in any error.

## Current Entity State

Use `defineEntity` when Lifecycle decisions need fresh state from the host instead of only
the Event payload. The host remains the system of record.

```ts
const patient = defineEntity({
  type: "patient",
  label: "Patient",
  state: z.object({
    status: z.enum(["active", "inactive"]),
    appointmentRemindersEnabled: z.boolean(),
  }),
  async resolve({ entityId }) {
    const record = await patients.findById(entityId);
    return record
      ? {
          status: record.status,
          appointmentRemindersEnabled: record.appointmentRemindersEnabled,
        }
      : null;
  },
});
```

`type` is the stable serialized identity of the Entity definition. `state` must describe a
JSON object. The resolver receives one `entityId`; returning `null` means that Entity no
longer exists. The resolver has 10 seconds to settle by default. A host can set
`entityResolverTimeoutMs` on `createWfGraphApp` or `wfWorker` to use another positive
whole-number deadline. A timeout, rejection, or schema-invalid state is an operational failure.
Workflow Graph validates the result and keeps the host as the system of record. When a
workflow tracks an Entity, the editor exposes the Entity's declared fields to text templates
and Condition nodes. It does not add an Entity lookup node or merge state into the Lifecycle
payload. Immediately before a consuming node runs, Workflow Graph resolves current state and
supplies only the fields that node reads. Those projected values are retained at the durable
node boundary so replay uses the same input. Full Entity State stays out of Workflow Graph
persistence, node outputs, logs, and audit metadata.

Give an Event one or more named bindings to reusable Entity definitions:

```ts
const appointmentScheduled = defineEvent({
  name: "appointment.scheduled",
  label: "Appointment scheduled",
  schema: z.object({
    appointmentId: z.string(),
    patientId: z.string(),
  }),
  entities: {
    patient: {
      entity: patient,
      selectEntityId: (event) => event.patientId,
    },
  },
});
```

An Event may expose another binding, such as `clinic`, beside `patient`. The record key
is the binding name the Lifecycle Node's inspector shows. `selectEntityId` receives
the validated Event value and must synchronously return a non-empty string. Different
Events may select the same Entity type from different payload fields. Pass only the Events
in `extensions.events`; assembly discovers their referenced Entity definitions transitively
and rejects distinct definitions with the same `type`.

A Workflow Builder may then select one tracked Entity type and one compatible binding for
each Start and Cancel Event. Tracking alone gives Concurrency and Cancel Events a typed
identity. The builder may also add one positive **Eligible when** condition over Entity
State and one or both checkpoints:

- **Before opening an Execution** runs after the payload Start Filter and before
  Concurrency. An ineligible arrival is a Refused Start and opens no Execution.
- **Before each workflow node** runs before every enabled executable node on the Started
  side. An ineligible run ends as `exited` before that node starts. The Canceled outlet does
  not run.

Selecting only the node checkpoint opens an Execution before the first resolver read.
Selecting both checks admission and reads fresh host state again at each new node. A Wait
is checked before it parks; a state change while parked is observed before the next node
only. A host that needs immediate interruption sends a Cancel Event.

Entity State fields appear while an Entity is tracked, whether or not Eligibility is
configured. Text templates and Condition nodes can read them on both Lifecycle sides. When a
Started-side node is also a before-node checkpoint, one resolver snapshot serves Eligibility,
templates, and the Condition. Separate nodes resolve separate snapshots. Removing tracking,
changing the tracked Entity type, or removing a referenced schema field keeps the draft
intact but blocks Publish until the reference is repaired.

A tracked manual or Draft run names a Start Event and supplies a payload so its selected
binding can establish typed Entity identity. Schedule-only tracked workflows cannot start.
The Entity type and ID remain immutable across Wait branches, durable replay, and Migration;
a target version tracking another Entity type is not a compatible Migration.

**`name` is the identity.** One Event covers one thing that happened. Declare
`appointment.created` and `appointment.canceled` as two Events, because the lifecycle model
states its rules over Event names. One umbrella Event with a subtype field is wrong.

**`schema` describes the payload as it arrives.** Write it in Effect Schema, Zod, or
arktype and pass it as it is. Workflow Graph needs both halves of Standard Schema from one object:

- the validate half checks an arriving payload;
- the JSON Schema half draws the field list in the editor.

An Event therefore requires a library that publishes both halves. A schema whose root is
another type than an object throws at definition and names the Event. The editor derives a readable label from the final property key, including common
initialisms (`appointmentId` becomes "Appointment ID" and `startsAt` becomes "Starts at").
Most fields need no title. JSON Schema `description` supplies separate help text. In Zod 4,
`.describe(...)` sets that help text. Use `.meta({ title, description })` only when the
intended label cannot be derived from the key.

A closed string set can label each choice separately while keeping its stored values stable.
Workflow Graph reads `title` from each singleton `const` or `enum` branch under JSON Schema
`anyOf` or `oneOf`. Zod emits that shape from an annotated literal union; Effect emits it
from `Schema.Enum`, whose object keys become titles:

```ts
const zodStatus = z.union([
  z.literal("InProgress").meta({ title: "In progress" }),
  z.literal("NeedsReview").meta({ title: "Needs review" }),
]);

const effectStatus = Schema.Enum({
  "In progress": "InProgress",
  "Needs review": "NeedsReview",
});
```

Conditions and Test Run payload fields show the titles and store the original values. An
unlabelled choice falls back to its stored value.

**`correlationPath` names where the Entity Value sits.** It is typed against the payload
and admits a path that resolves to a string.

- Workflows without a tracked Entity use that value for Concurrency and Cancel Events.
  Tracked workflows use the selected typed bindings instead.
- Two Events describe one entity when their Entity Values are equal, also where their paths
  differ.
- The path is optional. The author of an imported Event often lacks one, so the Workflow
  Builder supplies it on the Lifecycle Node. The path of the builder outranks the path of
  the author in every case.

**A datetime field declares `format: "date-time"`.** That JSON Schema keyword gives the
field the before and after operators in the condition builder, and it ranks the field to the
top of a menu that asks for a date.

```ts
z.iso.datetime(); // Zod
type("string.date.iso").configure({ format: "date-time" }); // arktype
Schema.String.annotate({ format: "date-time" }); // Effect, by hand
```

An Event in Effect Schema annotates the keyword by hand, because Effect's own date schemas
leave it out ([Effect-TS/effect#6790](https://github.com/Effect-TS/effect/issues/6790)).
Add `.check(Schema.isPattern(...))` where a malformed value must be turned away.

## The umbrella source

For an existing bus that sends one name and cannot change. `source` separates the identity
of an Event from its transport. The identity stays the Workflow Graph name, so the lifecycle
model is untouched, and `when` decides which Event an arrival on the umbrella name is.

```ts
const invoicePaid = defineEvent({
  name: "billing/invoice.paid",
  label: "Invoice paid",
  schema: Schema.Struct({
    type: Schema.String.annotate({ title: "Subtype" }),
    invoiceId: Schema.String,
  }),
  correlationPath: "invoiceId",
  source: { event: "billing/webhook", when: { path: "type", equals: "paid" } },
});
```

- A webhook message under the umbrella name is stored in the inbox under that name. The
  worker loop delivers it as the Event whose `when` its payload satisfies. An arrival no
  Event on the source accepts is marked delivered and starts nothing.
- `events.send` and `POST /api/events` take the Event's own name, so they need no filter.
  They also take the umbrella name, store the arrival as the Event whose `when` its payload
  satisfies, and refuse a payload that no Event on the source accepts. An `inngest.send`
  under the umbrella name reaches the inbox through `events.send`, so the same rule holds.
- Assembly refuses an Event whose name is another Event's umbrella name, because an
  arrival under that name could be either Event.
- Workflow Graph reads the filter's path at definition, so a path that names no field fails
  in the build of whoever wrote it.
- Assembly refuses two Events on one source that both omit `when`.

`when` decides which Event a payload is, for every workflow in the app, and it is the
Event Author's. A Workflow Builder narrowing which arrivals start or cancel their own
workflow writes a Start Filter or Cancel Filter on the Lifecycle Node. These filters
serve different scopes: `when` identifies the Event, and a lifecycle filter decides
whether that Event changes a run in one workflow.

## Sending an Event

An application sends an Event from its own code, from another process, or inside its own
database transaction. Each way stores
the Event in the event inbox, and the worker loop then opens every run the Event starts, in
your database. For more information, see Workflow runs in `docs/embedding.md`. An
application that already publishes its Events with `inngest.send` registers forwarders
instead; see Sending through Inngest.

**From the application's own code**, call `events.send` on the value `createWfGraphApp`
returns. The same method is on the value `createWfGraphRunner` returns.

```ts
const { id, duplicate } = await app.events.send({
  name: "app/appointment.created",
  data: { appointmentId: "appt_123" },
  id: "appointment-created-appt_123",
});
```

- `name` is the name of an Event in `extensions.events`, or the umbrella name it arrives
  under. An integration-owned Event is refused, because it arrives only through its
  integration's webhook, with the Connection it came through.
- `data` must pass the schema of that Event before the send resolves.
- `id` is optional. It is the idempotency key: a second send with the same `name` and `id`
  resolves with `duplicate: true` and the `id` of the first send, and it starts nothing.
  When the first send's delivery failed for good, a second send with the same `id` delivers
  that first send again and resolves with `duplicate: false`. The key holds for the
  deduplication window, which is the inbox's retention window.
- The promise resolves once the Event is stored in the event inbox, so a send that
  resolved survives a crash. The run starts in the worker loop shortly after.
- The promise rejects with `WfGraphEventRefused`, exported from `@wfgraph/core`, for an
  unknown name, a refused payload, or a malformed argument. Its message names the field
  and the rule and never repeats the value that was sent. Any other rejection is a storage
  failure, with the underlying error as its `cause`.

**From another process**, set `events: { key }` on `createWfGraphApp`. The app then accepts
`POST {basePath}/api/events`. The route is not mounted when `events.key` is unset.

```sh
curl -X POST https://app.example.com/api/events \
  -H "Authorization: Bearer $WFGRAPH_EVENTS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"app/appointment.created","data":{"appointmentId":"appt_123"},"id":"appointment-created-appt_123"}'
```

The body is `{ name, data, id? }`, with the same meaning as the arguments of `events.send`.
The route is a machine route: host `auth` does not run, and the key is the credential.
The route compares the key in constant time.

| Status | Body                | When                                                                 |
| ------ | ------------------- | -------------------------------------------------------------------- |
| 202    | `{ id, duplicate }` | The Event is stored. `duplicate` is true for a repeated `id`         |
| 400    | `{ error }`         | The body is not JSON, the name is unknown, or the payload is refused |
| 401    | `{ error }`         | The `Authorization` header is missing or holds another key           |
| 413    | `{ error }`         | The body is larger than 1 MiB                                        |

**From your own database transaction**, when your application shares the database that
`persistence` names, insert the inbox row in the transaction that produced the business
fact. The Event is then stored exactly when that transaction commits. The statement is the
same on PostgreSQL and SQLite:

```sql
insert into workflow_event_inbox (name, data, idempotency_key)
values ($1, $2, $3)
on conflict do nothing
```

- `name` and `data` are required, with the same meaning as in `events.send`. `data` is a
  JSON object.
- `idempotency_key` is optional, and `on conflict do nothing` makes a repeat a no-op.
- Leave every other column to its default. The worker loop's poll schedules the row after
  your transaction commits.
- On PostgreSQL the table is in the schema `persistence` names, `_workflows` by default, so
  qualify it or put that schema on the connection's `search_path`.
- Nothing checks the payload until the worker loop delivers it, so a refused payload is
  marked failed on its row.

**The deduplication window is the inbox's retention window.** An idempotency key holds while
the first send's inbox row exists. The worker loop deletes a row whose delivery has settled
once the row is older than `events.retentionMs`, which defaults to seven days, and a send with
the same `id` after that is a new Event that starts runs again. A sender that can retry for
longer than seven days sets a longer window. For the option, see Keep settled Events for a
window in `docs/embedding.md`.

## Sending through Inngest

An application that publishes its Events with `inngest.send` keeps doing so. The
`@wfgraph/core/inngest` entry builds one Inngest function, a forwarder, for each name a
host Event of the app arrives under, and each forwarder sends the Inngest event into
the inbox with `events.send`. Inngest runs no workflow: the worker loop delivers the
forwarded Event as it delivers every other one.

Install `inngest` beside `@wfgraph/core`. It is an optional peer dependency, and only this
entry imports it. Build the forwarders on your own Inngest client and register them with
your own `serve` or `connect`, beside your other Inngest functions:

```ts
import { Inngest } from "inngest";
import { serve } from "inngest/hono";
import { createWfGraphInngestFunctions } from "@wfgraph/core/inngest";

const inngest = new Inngest({ id: "my-app" });
const app = await createWfGraphApp({
  extensions /* , auth, persistence, encryption */,
});

const functions = [
  ...myFunctions,
  ...createWfGraphInngestFunctions({ client: inngest, app }),
];

// HTTP serve, mounted at your own route:
honoApp.on(
  ["GET", "POST", "PUT"],
  "/api/inngest",
  serve({ client: inngest, functions })
);
// Or a long-lived process dials out with `connect` from "inngest/connect":
// await connect({ apps: [{ client: inngest, functions }] });

await inngest.send({ name: "app/appointment.created", data: { appointment } });
```

- `app` is what `createWfGraphApp` or `createWfGraphRunner` returned. The forwarders are
  named by its `events.sourceNames`, the names its host Events arrive under, and they send
  through its `events`, so register them in a process that holds one.
- Your Inngest client, its signing key, its event key and the route or connection that
  reaches it are yours to configure. Workflow Graph mounts no Inngest route.
- The Inngest event's `id` is the idempotency key, so a second event with the same `id`
  starts nothing within the deduplication window. That window is the inbox's
  `events.retentionMs`, seven days by default, and Inngest's own 24-hour event
  deduplication plays no part in it. Inngest gives an event sent without an `id` one of its
  own, and a retried forwarder reads the same event, so a retry stores nothing twice. A
  forward answered as a duplicate writes an info record naming the event id and the inbox
  row it matched.
- An Event with an umbrella `source` is sent under its source name. One forwarder serves
  that name, and `events.send` tells which Event an arrival is by `when` (see The umbrella
  source).
- The forwarder checks the payload the way `events.send` does. A refused payload fails the
  Inngest run with `NonRetriableError` and stores nothing. A storage failure fails the step,
  and Inngest retries it.
- An integration-owned Event gets no forwarder: it reaches a workflow only through the
  Connection it arrived on, which an Inngest send does not carry.
- `createWfGraphInngestFunctions` throws when two forwarded names slug to one Inngest
  function id, such as `app/appointment.created` and `app-appointment-created`, because
  Inngest would register one and drop the other.

## The intake gate

**The gate is open by design.** Workflow Graph validates the declared fields and ignores a key that
the schema never heard of.

- The payload of an Event is the message of the host, and senders add fields routinely, so
  an additive change upstream must not stop intake.
- This is the one boundary in the repository that decodes this way. A declared field that
  drifts fails loudly, and an extra key passes in silence by choice.
- `events.send`, `POST /api/events` and the Inngest forwarders refuse a payload the gate
  refuses before storing it. An Event from a webhook, or from a row your own transaction
  inserted, is checked when the worker loop delivers it. A refused one is marked failed with
  the reason and is not retried, because a second attempt meets the same malformed payload.
  A resend with the same idempotency key delivers the stored Event again.

Workflow Graph carries the raw JSON into the workflow. The decoded value is used only by a
typed Entity ID selector and then discarded. A transform rewriting what the sender sent
would break a wait match that compares a literal captured at park time.

## The Lifecycle model

A Workflow Builder declares the Lifecycle Rules on the Lifecycle Node:

- which Events start a run and the payload filters for those Events;
- which Events cancel a run and the payload filters for those Events;
- optional Entity Eligibility over current host state and its checkpoints;
- the concurrency policy that applies to each typed Entity identity or legacy Entity Value.

`CONTEXT.md` defines Lifecycle Node, Start Event, Start Filter, Cancel Event, Cancel Filter,
Arriving Event, Concurrency, Precedence, Refused Start, and Execution status in full.
`docs/adr/0007` says why the model has this shape. An Event Author designs against that shape.

## Integration-owned Events

An integration may declare Events on `defineIntegration`. They are ordinary Events:
name identity, payload schema, Correlation Path, optional umbrella `source`. The
catalog stamps the owner so the editor offers a Connection picker. Publish requires
a Connection for a Start, Cancel, or Wait that names one of these. An Event sent with
`events.send`, `POST /api/events`, or a forwarded `inngest.send` arrives with no Connection. The
webhook route that produces integration Events records each one with the Connection it
arrived through; see `docs/embedding.md` and `docs/integrations.md`.
