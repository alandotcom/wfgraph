---
"@wfgraph/client": patch
---

The editor now reports the HTTP status a failed call was answered with. It used to derive the status from the error code, so a code outside oRPC's common table read as 500 whatever the server answered, and a proxy's 502 page reached the editor as 500. The workflow list and draft subscriptions now leave retry decisions to oRPC's default check, which stops on a 4xx other than 408 and 429.
