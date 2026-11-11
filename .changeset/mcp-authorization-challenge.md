---
"@wfgraph/core": minor
---

The MCP endpoint now answers a 401 with a `WWW-Authenticate` challenge. The new `mcp.authorization` option names the OAuth authorization servers (and optionally the scopes) for the endpoint; when it is set, Workflow Graph serves RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource${basePath}/api/mcp` and the challenge carries `resource_metadata`, so an MCP client can discover where to obtain a token. Without it the challenge is a bare `Bearer`. A 403 for an unaccepted `Host` or `Origin` now names `mcp.allowedHostnames` or `mcp.allowedOriginHostnames` and no longer quotes the rejected hostname. `WfGraphMcpAuthorization` is exported from `@wfgraph/core`.
