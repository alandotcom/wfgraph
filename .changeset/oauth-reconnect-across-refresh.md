---
"@wfgraph/core": patch
---

Reconnecting an OAuth connection no longer fails with "Integration configuration changed during OAuth callback" when a background token refresh ran while the operator was on the provider's consent page. The callback now claims the connection at the revision it reads, and still refuses a refresh, disconnect or second callback that runs between that read and its write.
