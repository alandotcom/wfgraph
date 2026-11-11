---
"@wfgraph/core": patch
---

On PostgreSQL, workers whose clocks disagree no longer take each other's live runs. Each worker measures how far its clock stands from the database's, and once that passes one second it writes and compares every lease on the database's clock. A cron schedule no longer fires a slot twice when a worker's clock steps backwards.
