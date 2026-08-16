---
"@wfgraph/core": major
---

Take `inngest` and `hono` as peer dependencies rather than dependencies. Add both to your
own manifest alongside `@wfgraph/core`:

```bash
pnpm add @wfgraph/core inngest hono
```

Your application now owns the version of each that runs in its process, inside `^4.18.0`
for `inngest` and `^4.13.1` for `hono`. For Inngest that is the point of the change: a host
that already drives Inngest functions of its own used to end up with a second copy of a
durable-execution runtime, carrying its own OpenTelemetry stack, protobuf codec and Connect
worker, as a silent outcome of an install. A version disagreement now fails at install,
where it can be read.

Nothing about the API moved. `createWfGraphApp` still takes the same `inngest` config object
and still builds its own Inngest client and its own Hono app, and it still answers with
`fetch`, `basePath` and `dispose`. Neither library appears in what it hands back, and no
published type names either one.
