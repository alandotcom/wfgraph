---
"@wfgraph/core": minor
---

The MCP authoring endpoint has its own entry, and the `mcp` option takes what that entry's function returns. Import `wfMcp` from `@wfgraph/core/mcp` and pass what it returns as `mcp` to `createWfGraphApp` or `wfWorker`. `wfMcp()` with no argument admits localhost alone, as `mcp: true` did, and `wfMcp(options)` takes the `allowedHostnames`, `allowedOriginHostnames` and optional `authorization` the object form took, with the same behavior.

`mcp: true` and the plain-object form are removed. Either one fails to type-check, and from JavaScript `createWfGraphApp` and `wfWorker` throw at startup with a message naming `wfMcp` and saying to leave `mcp` out to turn the endpoint off. `WfGraphMcpOptions` and `WfGraphMcpAuthorization` are no longer exported from `@wfgraph/core`; import them from `@wfgraph/core/mcp`. `@wfgraph/core` exports `WfGraphMcp`, the opaque type `wfMcp` returns.

A request whose `Host` or `Origin` header names a hostname the options do not admit is answered `403`, as before, and the message now names the `allowedHostnames` or `allowedOriginHostnames` option of `wfMcp`. Under `wfMcp()` it names `wfMcp({ allowedHostnames, allowedOriginHostnames })`.

Before:

```ts
createWfGraphApp({
  mcp: {
    allowedHostnames: ["workflows.example.com"],
    allowedOriginHostnames: [],
  },
});
```

After:

```ts
import { wfMcp } from "@wfgraph/core/mcp";

createWfGraphApp({
  mcp: wfMcp({
    allowedHostnames: ["workflows.example.com"],
    allowedOriginHostnames: [],
  }),
});
```
