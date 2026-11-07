---
"@wfgraph/core": patch
---

`@wfgraph/core` ships a new Agent Skill, `wfgraph-core/observability`, for sending Workflow Graph's logs and traces to the host's own tools: choosing between `configureWfGraphLogging()`, the `logger` option and a LogTape sink for the `wfgraph` category, registering an OpenTelemetry tracer provider or initialising Sentry, and building dashboards on the stable span names. The wfgraph-core skill keeps the one-line console setup and routes the rest there.
