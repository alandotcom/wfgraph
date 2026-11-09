---
"@wfgraph/core": patch
---

The database executor writes fewer rows for each node a run passes. A node's run-log row is no longer opened and closed through memoized steps, so each action node stores one step memo row instead of three and updates the run's schedule row once instead of three times, and each Wait stores one memo row fewer. That leaves less dead-row churn for PostgreSQL to vacuum. A pass reads the run's log rows when it starts and writes nothing for a node it replays. A second `error` close of a node's log row now keeps the first error's message and duration, and no close overwrites a row closed as a success.
