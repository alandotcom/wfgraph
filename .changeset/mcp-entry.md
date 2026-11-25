---
"@wfgraph/core": minor
---

The MCP authoring endpoint has its own entry, and the `mcp` option takes what that entry's function returns. Import `wfMcp` from `@wfgraph/core/mcp` and pass what it returns as `mcp` to `createWfGraphApp` or `wfWorker`. `wfMcp()` with no argument admits localhost alone, as `mcp: true` did, and `wfMcp(options)` takes the `allowedHostnames`, `allowedOriginHostnames` and optional `authorization` the object form took, with the same behavior.

`mcp: true` and the plain-object form are removed. Either one fails to type-check, and from JavaScript `createWfGraphApp` and `wfWorker` throw at startup with a message naming `wfMcp`. `WfGraphMcpOptions` and `WfGraphMcpAuthorization` are now exported from `@wfgraph/core/mcp`, and `@wfgraph/core` exports `WfGraphMcp`, the type `wfMcp` returns.

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

A host with no MCP endpoint no longer loads the MCP server.
