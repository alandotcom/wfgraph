---
"@wfgraph/core": patch
---

A connection update or saved-connection test that changes a `url` credential field, such as PostHog's API host, is now refused with `400` unless the same request supplies every stored `password` field again. A caller holding `connection.write` could otherwise point a stored secret at a host of their choosing, because the stored secret was reused. While an OAuth grant supplies the secret, the destination cannot change until OAuth is disconnected.
