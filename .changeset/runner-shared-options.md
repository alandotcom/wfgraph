---
"@wfgraph/core": minor
---

`createWfGraphRunner` now takes the options object `createWfGraphApp` takes, so a host builds one object in a shared module and passes `{ ...options, runner: false }` to the app and `options` to the runner. The runner ignores `auth`, `client`, `mcp`, `agent` and `events.key`, takes `auth` as optional, and ignores `runner: false`, since it always runs a loop. `CreateWfGraphRunnerOptions` is now `WfGraphAppOptions` with an optional `auth`. A mismatch between the two processes' database, key, extensions or retention windows used to fail silently.
