---
"@wfgraph/core": minor
"@wfgraph/client": minor
"@wfgraph/plugins": minor
"@wfgraph/shared": minor
---

Several run, connection and editor states that were spread across flags and separate writes now hold together.

Every path that ends a run commits its timeline entry in the same transaction as the write that ends it: a traversal's terminal record, a run the executor fails outside any node or for a missing version, an operator cancel, and a supersede. A crash between the two writes used to leave an ended run with no `run_completed`, `run_failed`, `run_cancelled` or `run_superseded` entry. Because a supersede can no longer be half recorded, `failedToSupersede` is gone from the manual start response and from start, delivery and cron outcomes. A run ended by a cancel, a supersede or a direct terminal insert now records a duration, and the Runs view reads every unfinished node of an ended run as cut off, whatever the run ended in.

A refresh claim on an OAuth connection is taken only from the state its caller read and is released back to that state, so a credential read that started before a connection was marked `reauthorization_required` can no longer return it to connected, and a reconnect that fails before its code exchange leaves it needing reauthorization. A Cancel Event now reaches its Entity's in-flight runs whatever the workflow's Published mode is now, so a run started in live mode is still cancelled after the workflow switches to test; this also lets a published workflow's Cancel Event reach Draft runs of that Entity, as ADR-0012 describes. A delay Wait reads only the keys its declared timing owns, so a duration Wait no longer waits for a stale `waitUntil`.

The run status `pending`, which no write stored, is removed from `WORKFLOW_EXECUTION_STATUSES`, and the run status in the logs summary and status poll contracts is typed by that list. Migrations on both backends add checks that tie each row's columns to its state: run, wait, node log and subscription vocabularies, run mode and start source on PostgreSQL as SQLite already had them, a schedule row's lease columns, a step memo's value and failure count, a wait row's wake, at most one wait row per Wait node in a run, a connection's refresh claim, and an OAuth attempt's mode and result. The version a workflow publishes can no longer be deleted while the workflow points at it. Every current writer satisfies these checks.

In the editor, a save failure is reported once and stays on the workflow it happened on, an interrupted node drag ends and moves back, reopening a workflow shows an edit its save still carries, Run stays busy until a started run is read, an agent turn's graph lands on the Draft from any view, and the draft and workflow-list subscriptions reconnect after the server ends them normally.
