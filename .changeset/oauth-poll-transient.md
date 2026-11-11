---
"@wfgraph/client": patch
---

A dropped connection or a 5xx answer while the editor checks an OAuth authorization no longer closes the provider popup during consent. The editor keeps checking until the authorization finishes or times out. It also reads the connection list again however the check ends, because the grant may have completed after the last answer.
