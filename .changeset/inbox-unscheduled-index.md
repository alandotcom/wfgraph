---
"@wfgraph/core": patch
---

The worker loop's inbox poll stays fast behind a deep backlog of Events waiting for delivery. The executor now marks each inbox row it gives a delivery schedule row in a new nullable `scheduled_at` column, and the poll reads a partial index of unmarked pending rows alone, where it used to walk every pending row and look for its schedule row. Run the new PostgreSQL migration (`@wfgraph/core/migrate`) before deploying; SQLite migrates on open. A host's own `insert into workflow_event_inbox` naming its columns is unchanged and leaves the column to its default.
