# The host API takes any Standard Schema

A host hands Rova one Standard Schema per Event and per action. Rova reads it and
asks for nothing else: no annotation on every path, no Rova-branded field helper,
no Effect. Today it asks for all three, and this plan removes them.

## What is wrong

The schema is doing two jobs, and only one belongs to the host. Validation is the
host's. Presentation is Rova's: a label per path, the fact that a string holds a
moment in time, the list the template picker offers. Rova reads both off the same
object, so a host has to edit their schema to serve the editor.

The two entry points already disagree about this, which is the clearest evidence
that the strict half is policy rather than mechanism. A plain Zod schema with no
descriptions:

```ts
const Appointment = z.object({
  id: z.string(),
  startsAt: z.iso.datetime(),
  patientName: z.string(),
  status: z.string(),
});
```

`createAction` accepts it. It humanises each key into a label ("Appointment Id"),
and it reads `startsAt` as a timestamp because Zod emits `format: "date-time"`.

`defineEvent` refuses it:

```
Event "app/appointment.created" cannot derive the fields the editor offers:
appointment, appointment.id, appointment.startsAt, ... carry no description
annotation. ... Annotate the encoded side with `Schema.annotateEncoded`, or use
`timestampField` / `dateField`. `Schema.Date` cannot be described at all; use
`dateField` instead.
```

A Zod author is told to reach for three Effect APIs.

## The channel that already works

`format: "date-time"` in the JSON Schema is how a Standard Schema says a string is
a timestamp. It is JSON Schema's own vocabulary, every library can emit it, and
`schema-codec.ts:258` already reads it.

- **Zod** emits it from `z.iso.datetime()`.
- **arktype** emits it through the `fallback.date` option `schema-codec.ts:11`
  already passes.
- **valibot** has `v.pipe(v.string(), v.isoTimestamp())`. What
  `@valibot/to-json-schema` emits for it is unverified. Check before claiming it.
- **Effect** emits nothing, for `Schema.Date` and for `Schema.DateFromString`
  alike. Both render as bare `{"type":"string"}`.

So there is one broken library, and it is the one Rova is written in. Filed
upstream as [Effect-TS/effect#6790](https://github.com/Effect-TS/effect/issues/6790),
with a one-line fix: annotate the internal `DateString` at `Schema.ts:11814` the
way `Base64String` at `Schema.ts:13242` is already annotated. Both date paths
route through it.

`timestampField` and `dateField` exist to work around that one bug. They are not
part of the design and they should not be in the public API.

## Steps

### 1. Stop refusing an unannotated schema

- Delete the `unannotated` arm and `CODEC_ANNOTATION_HINT` from
  `packages/shared/src/workflow/output-fields.ts:153-197`. `createAction` runs
  without it today, so nothing needs replacing.
- In `packages/shared/src/workflow/node-references.ts:52`, change the label
  fallback from the type name to the title-cased key. `cancelledAt` reads as
  "Cancelled At" rather than "timestamp". `configFieldsFromJsonSchema` already
  does this, so the two paths converge on one rule.
- `event-timestamp-field.test.ts` asserts the old behaviour and has to change.

The other arms of `findDerivationProblem` stay. A root that is not an object and a
property that did not survive derivation are still definition mistakes.

### 2. Make `examples` its own package

The example currently borrows the root's dependencies, so the root manifest is the
example's manifest wearing a disguise. `examples/app.ts:31` is the only import of
`effect` outside `packages/`.

- Add `examples/package.json`: `@rova/example-app`, private. Dependencies
  `@rova/core`, `@rova/plugins`, `@rova/client`, `dotenv`, `zod`. Dev dependency
  `tsx`. It owns `dev` and `start`.
- Add `examples` to `packages` in `pnpm-workspace.yaml`.
- Drop `@rova/core`, `@rova/plugins`, `dotenv` and `effect` from the root
  dependencies, and `@rova/client` from the root dev dependencies. What is left at
  the root is tooling.
- Root `dev:app` and `start` delegate with `pnpm --filter @rova/example-app`.
- `load-env.ts` stays at the root for `scripts/migrate.ts`. The example inlines the
  two dotenv lines, which is what an adopter writes anyway.
- `knip.ts` gains an `examples` workspace and loses `examples/**/*.ts` from the
  root project glob.

This is what makes the claim enforceable. pnpm symlinks only declared
dependencies, so once `effect` leaves the root manifest, neither node nor tsc can
resolve it from inside the example. "An adopter needs no Effect" stops being a
promise in a document.

Known gap: `vitest.config.ts` scopes the node project to `packages/*/src`, so a
test file under `examples` would run nowhere. Widen the glob or accept that the
example has no tests.

### 3. Rewrite the example in Zod

Dates become `z.iso.datetime()` and ask nothing of Rova. Descriptions stay only
where the key name reads badly, which is the point: an adopter sees what is
required and what is decoration.

### 4. Delete `timestampField` and `dateField`

Remove both from `@rova/core` and `@rova/core/plugin`, and delete them from
`packages/shared/src/types/timestamp.ts`. The rest of that module stays: the ISO
pattern and the encode/decode pair are used elsewhere.

`packages/plugins` is the only other caller. It is ours, so it takes a plain
`format: "date-time"` annotation.

Worth knowing while touching it: Zod's `z.iso.datetime()` emits the same
leap-year-aware pattern that `timestamp.ts` hand-rolled. The comment there says
the regex exists because Effect's date schemas accept whatever `new Date()` makes
of a string, which is true, but it is less bespoke than it reads.

### 5. Shrink AGENTS.md

Four things in it exist only because the host API was written in Effect:

- "Zod is a test fixture, nothing more." The example is a real consumer now.
- The `format: "date-time"` paragraph explaining `timestampField` and `dateField`.
- "Annotate the base type before any check." [Diverged: this rule stayed — the
  hand-written `format` annotation this plan introduces depends on it.]
- The note on `Schema.Date` being refused at registration.

The package list at the top gains `@rova/example-app`.

## Order

Step 1 unblocks step 3. Steps 2 and 4 depend on 3. Step 5 is last, once the code
it describes is gone.

## Open

- Verify what `@valibot/to-json-schema` emits for `isoTimestamp`.
- Until [#6790](https://github.com/Effect-TS/effect/issues/6790) lands, an Effect
  author writing an Event gets no timestamp detection. Either bridge it in Rova
  through the public `.ast` (the `Declaration` node carries
  `annotations.representation.id === "effect/schema/Date"`), or let them write the
  `format: "date-time"` annotation themselves. Nothing in the repo needs this once
  the example is Zod, so it can wait for upstream.
- `createAction`'s `outputFields` override and its second overload exist because
  derivation was unreliable. If it is reliable, both can go.
