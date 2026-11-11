---
"@wfgraph/core": patch
---

A Condition node and an Event Split now decide their route once and keep it for the rest of the run. Each pass of a run replays the graph from the top, and the Condition used to evaluate its expression again on every pass, so a condition reading `now` (any "within the next N days" rule) could take the true branch, park on a Wait below it, and then take the false branch on the pass after the Wait, running the other branch and never reaching the nodes below the Wait. The decision is now stored as a durable step of the node, which adds one step memo row per Condition and Event Split node a run passes. When two nodes produce a field of the same name, the one later in the graph's node order now wins in a Condition, where the one that finished later used to.
