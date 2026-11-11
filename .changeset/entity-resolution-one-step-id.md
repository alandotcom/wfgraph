---
"@wfgraph/core": patch
---

A Migration that adds an Entity template to a node a run already passed, or removes one, no longer resolves that node's Entity again when the run resumes. The resolution was memoized under a step id that depended on whether the node read Entity fields, so the changed node was checked against current Entity State a second time and could end the run with an Exit claimed against a node that finished before the Migration. The step id is now the same either way.
