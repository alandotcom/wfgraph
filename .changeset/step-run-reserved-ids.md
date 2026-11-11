---
"@wfgraph/core": patch
---

A `step.run` name now lives in a namespace of its own, so an author's step can no longer share a durable id with one of the engine's steps for the same node. Before, a step named `"log-open"` could answer the `null` the engine stored for its run-log open and skip its work. Each named step is now memoized as `node:<nodeId>:step:<name>`, so a run that was in flight across the upgrade runs its completed `step.run` calls once more. `step.run` refuses an empty name and a name longer than 64 characters, failing the node with a message that names the action.
