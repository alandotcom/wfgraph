---
"@wfgraph/core": patch
---

Recover the runs that a Cancel claim or a delivery retry used to strand.

- A Wait behind the Canceled outlet now parks, wakes on its Event, and runs as a durable branch; before, the Cancel claim refused the park and the cleanup nodes behind it never ran.
- A fatal engine failure that finds a Cancel claim at the terminal write now runs the Canceled outlet before recording `canceled`. An interrupted attempt writes no terminal record, so the retry runs the outlet.
- A retried Event delivery answers from the admission decision an earlier attempt committed before it reads the current publication, so a Publish, unpublish, or catalog change between attempts no longer strands a committed Execution at `pending`.
- A woken Wait is settled by the run that consumed it, so a settle write that fails after the signal was accepted no longer leaves the row at `resuming` or reports a failed resume for a run that woke.
- Cancelling a run that is already canceling now answers a conflict instead of an internal failure, so the Runs panel says the run is on its way out rather than reporting a failure.
- Every id Workflow Graph mints, including workflow, version, run, integration, node, edge and condition ids, is now a 36-character UUIDv7 string rather than a 21-character nanoid, so an adopter reading one off the API or a saved graph sees the longer, time-ordered form. Rows written before the upgrade keep the ids they already hold, so a database can carry both shapes.
- A run's audit timeline now reads newest first in insertion order, including for rows a single transaction wrote in the same instant. This ships a PostgreSQL migration that adds a `seq` identity column to `workflow_execution_events` and rebuilds that table's three indexes; SQLite needs no migration.
