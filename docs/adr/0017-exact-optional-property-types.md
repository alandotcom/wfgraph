# 17. exactOptionalPropertyTypes is on and optional keys are widened

Date: 2026-09-02

## Status

Accepted.

## Context

TypeScript reads `k?: T` as `k?: T | undefined` unless
`exactOptionalPropertyTypes` is set, so a target declaring an optional key
accepted both a missing key and a key present and holding `undefined`. The two
are not the same thing anywhere the value leaves the process. JSON has no
`undefined`, so an absent key and a key written as `undefined` encode
identically and decode as absent. A database column is either written or left
alone. A `Object.hasOwn` read, which several codecs in this repo use to ask
whether a document declared a keyword, answers true for a key holding
`undefined`.

Without the flag the compiler could not tell those apart, and the repo had begun
hand-writing conditional spreads (`...(x === undefined ? {} : { k: x })`) at
call sites to keep a key out of an object the compiler would have accepted it
in.

## Decision

`exactOptionalPropertyTypes` was turned on in the root `tsconfig.json`, so a
target declared `k?: T` refuses a `k` holding `undefined`. That is the same
distinction the wire and the database make.

Because JSON has no `undefined`, internal types were widened to
`k?: T | undefined` and keys were written plainly, rather than each call site
deciding whether to write the key at all. `omitUndefined`
(`packages/shared/src/utils/omit-undefined.ts`) was kept for the three cases
where the key really has to be absent:

- A third-party library reads presence with `in` or `Object.hasOwn`.
- An oRPC contract declares `Schema.optionalKey`. `Schema.optional` was not used
  in its place, because it renders as nullable in the served OpenAPI document
  while the server rejects `null`, and oRPC transmits `undefined` as a typed
  value.
- A patch merges over stored data, where a key holding `undefined` would erase
  the stored value.

Every type an adopter writes states `| undefined` on its optional properties, so
an adopter compiling with the flag passes a maybe-undefined value plainly rather
than filtering it out first.

Per-package enablement was rejected: a shape crosses packages, and one package
compiling under the looser reading would hand the stricter package a value it
had never checked. Leaving the flag off was rejected because the repo was
already paying for the distinction by hand.

## Consequences

An optional property in this repo is read as "the key may be missing, and its
value may be `undefined`" everywhere except an adopter-facing wire shape, where
`Schema.optionalKey` and `omitUndefined` say the key is absent.

A `?: T` with no `| undefined` on a published type is now a bug an adopter
finds, because it refuses a variable their own code typed as `T | undefined`.

A codec asking `Object.hasOwn` about a keyword is only correct while the writer
never emits that key holding `undefined`, which the flag does not check: both
halves are inside the program and the widened type admits the value. The
emitters that feed such a reader run their result through `omitUndefined`, and
`packages/shared/src/graph/schema-codec.ts` is where that pairing lives.

No adopter code was migrated, because the flag is set only in this repository's
`tsconfig.json`. An adopter who leaves it off sees no change; one who turns it
on can now pass optional values through without a filter.
