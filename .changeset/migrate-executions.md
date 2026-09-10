---
"@wfgraph/core": minor
"@wfgraph/client": minor
"@wfgraph/shared": minor
---

Move parked runs to another published version

An adopter can now move a run that is parked on a Wait from the version it
pinned to another published version of the same workflow, through
`workflow.previewMigration` and `workflow.migrateExecutions`. A delay Wait now
parks on a signal-interruptible timeout, and a Wait's output reports `hops`, how
many times the run parked at that node.

An adopter with parked runs drains them before upgrading to this release. Wait
step ids and the delay park changed, so a run parked under an earlier release
resumes into a handler that has none of the steps it parked under.
