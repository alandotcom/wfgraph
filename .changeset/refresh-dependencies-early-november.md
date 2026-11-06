---
"@wfgraph/core": patch
"@wfgraph/client": patch
"@wfgraph/plugins": patch
---

Take the latest minor and patch releases of the runtime dependencies. `@wfgraph/core` now needs `@hono/node-server` `^2.1.6` and `@opentelemetry/semantic-conventions` `^1.44.0`, and its `hono` peer range rises to `^4.13.16` and its optional `inngest` peer range to `^4.26.2`. `@wfgraph/plugins` now needs `@clerk/backend` `^3.27.0`. The editor bundle in `@wfgraph/client` carries `@tanstack/react-query` 5.106.1, `@xyflow/react` 12.12.1, `lucide-react` 1.69.0 and `motion` 14.9.1.
