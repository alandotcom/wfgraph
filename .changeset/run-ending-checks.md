---
"@wfgraph/core": patch
---

The database now holds a run's `completed_at`, `waiting_at` and `cancelled_at` to its status on PostgreSQL and SQLite: `completed_at` is set exactly when the run has ended, `waiting_at` exactly while it waits, and `cancelled_at` exactly when it was canceled. The run-history retention sweep finds ended runs by `completed_at`, so an ended run missing it would never have been swept. A database holding a row that breaks one of these pairings fails the migration that adds them.
