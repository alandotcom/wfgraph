---
"@wfgraph/core": patch
---

Recover persisted arrivals when a wake signal is missed before listener registration. Resolve timeout races atomically and give each new event park a fresh resume token so stale deliveries cannot claim it.
