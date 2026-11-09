---
"@wfgraph/core": patch
---

A PostgreSQL migration replaces the index on `workflow_execution_schedule` that the executor uses to find expired leases. The index now covers the `id` of each leased row, and no index covers `lease_expires_at`, so PostgreSQL applies a running workflow's lease renewals as HOT updates. The executor's schedule table collects far fewer dead rows under load. Run the migration as you run any other Workflow Graph migration.
