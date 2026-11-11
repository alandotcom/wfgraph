---
"@wfgraph/core": patch
---

A deploy that changes the extension catalog no longer fails the actions a parked run has already finished. The catalog fingerprint check now applies to an action node that has not finished; a node an earlier pass completed is replayed from its step memo without the check. Any catalog change, adding an unrelated action included, still fails a node of a pinned run that runs for the first time after the deploy, and that node now records its failure on its run-log row.
