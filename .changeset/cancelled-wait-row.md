---
"@wfgraph/core": patch
---

A Wait that a Cancel or Exit claim stopped, whether it was parked or had not parked yet, no longer closes its run-log row as `success`. The row stays open, and once the run has ended the Runs view and the run status read show it as `cancelled`, beside the run's cancellation. The Wait's node output is unchanged.
