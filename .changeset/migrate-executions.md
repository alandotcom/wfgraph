---
"@wfgraph/core": minor
"@wfgraph/client": minor
"@wfgraph/shared": minor
---

Move parked runs to a later published version

An adopter can now move a run that is parked on a Wait from the version it
pinned to a later published version of the same workflow, through
`workflow.previewMigration` and `workflow.migrateExecutions`. A delay Wait now
parks on a signal-interruptible timeout, and a Wait's output reports `hops`, how
many times the run parked at that node.
