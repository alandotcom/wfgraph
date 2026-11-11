---
"@wfgraph/core": patch
---

Request bodies to the RPC, REST and `POST /api/integrations/oauth/start` routes are now capped at 8 MiB, enough for a 500-node workflow save. A larger body answers `413 Request body is too large` before any handler reads it. These routes used to read a body of any size into memory.
