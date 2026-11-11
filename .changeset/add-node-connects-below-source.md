---
"@wfgraph/core": minor
---

`add_node` takes an optional `sourceNodeId` and `sourceHandle` and connects the new step below that node in the same call, so its config can carry references to the steps above it. Without a source the step arrives unconnected and its config takes literal values only, which the `value` description and the refusal now both say.
