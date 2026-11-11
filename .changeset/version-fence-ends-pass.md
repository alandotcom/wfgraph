---
"@wfgraph/core": patch
---

A Wait whose park or resume is refused because a Migration moved the run to another Workflow Version now ends the pass quietly, and the next pass runs the version the run was moved to. The refusal used to be recorded as a failed node and logged as an unexpected node error and a fatal run error, while the other branches of the pass kept running.
