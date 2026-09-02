# Defining an Event

How an Event Author declares Events, umbrella sources, the intake gate, and how that fits the Lifecycle model.

An Event is a named payload shape that your application raises.

```ts
const paymentSettled = defineEvent({
  name: "billing/payment.settled",
  label: "Payment settled",
  description: "The billing service raises this Event when a charge clears.",
  schema: z.object({
    appointmentId: z.string().describe("Appointment ID"),
    amountCents: z.number().describe("Amount settled, in cents"),
    settledAt: z.iso.datetime(),
  }),
  correlationPath: "appointmentId",
});
```

The lifecycle role of an Event belongs to the editor. Each Workflow Builder declares there
which workflow it starts and which it cancels (`docs/adr/0007`).

`defineEvent` builds a value. Pass it in `extensions.events`, where assembly checks it and
names the Event in any error.

**`name` is the identity.** One Event covers one thing that happened. Declare
`appointment.created` and `appointment.canceled` as two Events, because the lifecycle model
states its rules over Event names. One umbrella Event with a subtype field is wrong.

**`schema` describes the payload as it arrives.** Write it in Effect Schema, Zod, or
arktype and pass it as it is. Workflow Graph needs both halves of Standard Schema from one object:

- the validate half checks an arriving payload;
- the JSON Schema half draws the field list in the editor.

An Event therefore requires a library that publishes both halves. A schema whose root is
another type than an object throws at definition and names the Event. A `description` on a
path replaces the label that the editor derives from the key ("Starts At").

**`correlationPath` names where the Entity Value sits.** It is typed against the payload
and admits a path that resolves to a string.

- Runs that share that value are about the same entity. Concurrency, Cancel Events, and the
  match of a Wait node act on it.
- Two Events describe one entity when their Entity Values are equal, also where their paths
  differ.
- The path is optional. The author of an imported Event often lacks one, so the Workflow
  Builder supplies it in the Lifecycle panel. The path of the builder outranks the path of
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
of an Event from its transport. The identity stays the Workflow Graph name, so the lifecycle model is
untouched, and `when` becomes the filter of the listener.

```ts
const invoicePaid = defineEvent({
  name: "billing/invoice.paid",
  label: "Invoice paid",
  schema: Schema.Struct({
    type: Schema.String.annotate({ description: "Subtype" }),
    invoiceId: Schema.String.annotate({ description: "Invoice ID" }),
  }),
  correlationPath: "invoiceId",
  source: { event: "billing/webhook", when: { path: "type", equals: "paid" } },
});
```

- Each listener carries its filter as the `if` of its Inngest trigger, so the bus decides
  which Event a payload is. It invokes a listener only for a subtype an Event declares.
- Workflow Graph compiles the filter at definition, so an expression it cannot build fails in the
  build of whoever wrote it.
- Assembly refuses two Events on one source that both omit `when`.

`when` decides which Event a payload is, for every workflow in the app, and it is the
Event Author's. A Workflow Builder narrowing which arrivals of an Event start their own
workflow writes a Start Filter on the Lifecycle Node instead. The two never compete:
`when` settles which Event a payload is, and a Start Filter settles whether that
Event opens a run here.

## The intake gate

Send an Event with an Inngest client. The listener of that Event delivers it, so the run is
durable from the moment the send returns.

```ts
inngest.send({ name: "app/appointment.created", data: { appointment } });
```

**The gate is open by design.** Workflow Graph validates the declared fields and ignores a key that
the schema never heard of.

- The payload of an Event is the message of the host, and senders add fields routinely, so
  an additive change upstream must not stop intake.
- This is the one boundary in the repository that decodes this way. A declared field that
  drifts fails loudly, and an extra key passes in silence by choice.
- Workflow Graph logs a refusal and stops there, because a second attempt meets the same malformed
  payload.

Workflow Graph discards what the gate decoded to and carries the raw JSON on. Every consumer
downstream reads that JSON directly. A transform rewrites what the sender sent, and one
`Date` round trip breaks a wait match that compares a literal captured at park time.

## The Lifecycle model

A Workflow Builder declares the Lifecycle Rules in the Lifecycle panel:

- which Events start a run;
- which Events cancel one;
- the concurrency policy that applies to each Entity Value.

`CONTEXT.md` defines Lifecycle Node, Start Event, Cancel Events, Arriving Event, Concurrency,
Precedence, Refused Start, and Execution status in full. `docs/adr/0007` says why the model looks like
this. An Event Author designs against that shape.

## Integration-owned Events

An integration may declare Events on `defineIntegration`. They are ordinary Events:
name identity, payload schema, Correlation Path, optional umbrella `source`. The
catalog stamps the owner so the editor offers a Connection picker. Publish requires
a Connection for a Start, Cancel, or Wait that names one of these. Host Events still
arrive through `inngest.send` with no Connection. The webhook route that produces
integration Events is on machine routes; see `docs/embedding.md` and
`docs/integrations.md`.
