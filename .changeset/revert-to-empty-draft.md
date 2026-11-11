---
"@wfgraph/core": patch
---

The build agent's `revert_draft` now works in a turn that began on an empty workflow. It was refused with "Workflow must contain one Lifecycle Node", which left the half-built graph in place.
