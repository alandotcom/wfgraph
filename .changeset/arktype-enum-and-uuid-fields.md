---
"@wfgraph/core": patch
---

Keep arktype, Zod, and Effect closed sets and UUIDs in the fields the editor
derives, and stop marking a multi-branch `anyOf` nullable when no branch is
`{ type: "null" }`.

arktype renders a string-literal union as a bare `enum` with no `type`, and
`string.uuid` as a pattern plus the nil and max UUID consts. Zod puts `type` on
`z.enum` and `z.uuid`, but a literal union is `anyOf` of typed consts. Effect's
`Schema.Literals` is one `enum` array, while `Schema.Enum` is one `anyOf` branch
per member and `NullOr` wraps that in another `anyOf`. The JSON Schema reader
dropped the arktype shapes and Effect's `Schema.Enum`, and marked every
multi-branch `anyOf` nullable, so an Event threw at boot, an action output
silently omitted the field, and a described union offered is-empty operators on
a required enum.
