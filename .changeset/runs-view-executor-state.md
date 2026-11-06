---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

The Runs view says what the database executor is doing about a run in progress. The run overview names the worker running a step, a step's next try ("Retrying “Send reminder” at 11:40:34, try 3 of 5"), a run whose worker stopped renewing its lease, a run no worker has claimed past the host's stall threshold, and a run resuming from an Event, a resume or a deadline, with the raw schedule fields under "Executor details". A retrying node reads "Retrying" on the canvas and in the run's node journey, its evidence names the next try, and both run lists say when a run is retrying, stalled or unclaimed. Each node log keeps its retry count after the run ends, so a finished node reads "Succeeded on try 3".

`getExecutionLogs`, `getExecutions`, `getExecutionsGlobal` and `getExecutionStatus` carry the new fields, and the client and core must be on the same version. Two migrations add `retries` to the node log, the running node to the schedule row, the node id to each step memo row, and a unique index on one log row per run and node. A run that finishes on SQLite now stores its duration as whole milliseconds, so the run history reads "55.05s" in place of "55051.0".
