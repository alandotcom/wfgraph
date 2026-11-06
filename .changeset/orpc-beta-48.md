---
"@wfgraph/core": patch
"@wfgraph/client": patch
---

Update the six `@orpc` packages from 2.0.0-beta.47 to 2.0.0-beta.48. The editor bundle and the server move together, so their oRPC contract still matches. The REST routes now resolve through oRPC's new OpenAPI router. Where a literal path segment and a parameter overlap, as `/workflows/current` and `/workflows/{workflowId}` do, the literal route answers, which is how those routes already resolved.
