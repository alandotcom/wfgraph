---
"@wfgraph/core": minor
---

`createWfGraphApp` answers a new `health()`, which checks that the database answers a one-row read within five seconds and, when the app runs a worker loop, that the loop finished a turn of polling and claiming within two poll intervals and never less than a minute. It never rejects. The new `health: true` option mounts `GET {basePath}/api/health`, a readiness route outside `auth` that answers `{ ok, checkedAt, database, runner }` with 200 when ok and 503 otherwise. `WfGraphHealth` and `WfGraphRunnerHealth` are exported.
