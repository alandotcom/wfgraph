---
"@wfgraph/core": patch
---

A run whose pinned workflow version no longer exists now ends canceled or exited when it holds a Cancel or Exit claim, with the timeline entry for that status. It used to be refused the `failed` status and stay in flight.
