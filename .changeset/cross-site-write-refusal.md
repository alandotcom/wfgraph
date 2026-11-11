---
"@wfgraph/core": patch
---

Operator routes now refuse a write that a browser sends from another site. A `POST`, `PUT`, `PATCH` or `DELETE` to the RPC, REST or OAuth routes answers `403` when its `Sec-Fetch-Site` is `cross-site` or `same-site` and its `Origin` is neither the configured `publicUrl` nor the request's own origin. A request with `Origin` and no `Sec-Fetch-Site` is held to the same origins, and a request with neither header, such as a server-side client, is unaffected. `POST /api/integrations/oauth/start` now also requires `Content-Type: application/json` and answers `415` otherwise. Before this, a cookie-authenticated write relied on the host cookie's `SameSite` setting alone, so a form posted from a sibling subdomain reached mutating routes.
