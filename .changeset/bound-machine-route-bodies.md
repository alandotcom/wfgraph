---
"@wfgraph/core": patch
---

Bound the request body on the routes host `auth` does not guard. The wait-resume and webhook routes read the body before the token or the Connection has been looked up, so a body over 1 MiB is now answered with 413 rather than buffered.
