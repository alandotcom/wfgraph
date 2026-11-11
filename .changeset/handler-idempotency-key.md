---
"@wfgraph/core": minor
---

A handler's bag now carries `idempotencyKey`, a string built from the run's id and the node's id that stays the same on every pass and retry of that node, to hand a vendor that deduplicates requests by key. Inside `step.run`, the Promise form's work is handed `{ idempotencyKey }` for that step, and `step.idempotencyKey(name)` answers the same key for any step name, so two calls in one handler use two keys. `executionId` on the bag is now always a string. `runAction` and `runHostAction` from `@wfgraph/core/testing` stand a case in for the run `execution_test` unless `node.executionId` names another.
