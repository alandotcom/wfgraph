---
"@wfgraph/core": minor
---

`runHostAction` from `@wfgraph/core/testing` now runs a host action the way one pass of a run runs its node. It answers `handlerRan` and the `memo` the pass leaves, and takes `memo` in place of `replay`: an earlier run's `memo` holds the handler's answer, so a case can assert that a later pass does not call the handler again, and `memo: { steps: { name: value } }` answers a `step.run` from a stored value, as `replay` did. A `step.run` whose work throws now rejects the promise with that error, because the executor retries such a step rather than failing the node.
