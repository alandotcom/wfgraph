---
"@wfgraph/core": patch
---

A manual Run on a paused workflow now commits its ignored run and the run's `run_ignored` timeline entry in one transaction. A crash or a refused insert between the two writes used to leave an ignored run in the Runs view with no entry saying why it was ignored.
