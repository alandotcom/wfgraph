---
"@wfgraph/core": minor
---

`@wfgraph/core/testing` now exports `runHostAction(action, { input, runMode, credentials, replay })`, which runs a host action built with `defineAction` through the whole step boundary and resolves with the envelope the engine reads and every `step.run` its handler made. `replay` answers a step from a stored value without running its work, the way the executor answers a step that ran on an earlier pass. `RecordedStep` and `HostActionRun` are exported beside it.
