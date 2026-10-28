---
"@wfgraph/core": minor
---

Refresh every dependency to its newest release older than pnpm's one-day release-age gate.

What an adopter installs changes: Effect and its four `@effect/*` packages move to 4.0.6,
the six `@orpc` packages move to 2.0.0-beta.46, `@orpc/experimental-effect` is replaced by
its renamed successor `@orpc/effect`, `@modelcontextprotocol/server` moves to 2.4.0, and
`@wfgraph/plugins` now needs `@linear/sdk` 99. The `hono` and `inngest` peer ranges rise to
`^4.13.14` and `^4.26.0`.

`StepFailure` and the other `Schema.TaggedError` classes now carry a brand type argument,
so a value that only resembles one of them structurally no longer type-checks where the
class is expected.

Effect 4.0.6 makes `Schema.toStandardSchemaV1` and `Schema.toStandardJSONSchemaV1` return
a copy rather than assign onto the schema they are given. An Effect schema handed to
`defineAction`, `defineEvent` or `defineEntity` is therefore left as the author wrote it,
and one that was already bridged with parse options keeps them.

The editor shows "Request failed" for a response that is not an oRPC response, such as a
proxy's error page, where oRPC beta.46 would otherwise copy that page's body into the
message.

The OpenTelemetry API stays on 1.9 and the OpenTelemetry SDK on 2.x, because
`@effect/opentelemetry` 4.0.6 caps the SDK below 3.0 and the 2.x SDK caps the API below
1.10. `@types/node` stays on 24 to match the `engines` floor.
