---
"@wfgraph/core": minor
"@wfgraph/client": minor
"@wfgraph/shared": minor
---

Expose current tracked Entity State as a virtual template source when Entity Eligibility is configured. Each consuming node resolves its referenced fields immediately before execution, shares that snapshot with before-node Eligibility, and retains only projected values for durable replay.
