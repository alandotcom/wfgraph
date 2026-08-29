---
"@wfgraph/core": minor
"@wfgraph/client": minor
"@wfgraph/shared": minor
---

A workflow version now says which of two kinds it is. `workflow_versions` gains a `kind` column holding `published` or `draft_snapshot`, and its `version` number is nullable because a snapshot claims none. A published version is what Publish mints and what `published_version_id` points at; a snapshot is the frozen draft graph a test-mode draft run pins itself to, and it stays out of the version history, out of the next-version number, and out of the Event subscription index. Postgres takes a migration; a SQLite database migrates itself on open, rebuilding the table with its foreign keys intact.

`workflow.execute` takes an optional `graph` of `"published"` or `"draft"`. Absent means published, which is what every existing caller sends and what every Event start runs.

Every run a client reads now carries `versionKind`, on the two run-list procedures and on the run summary `getExecutionLogs` answers with, so run history can tell a draft run from a run of the published graph.
