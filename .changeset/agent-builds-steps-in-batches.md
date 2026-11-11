---
"@wfgraph/core": patch
---

The build agent's instructions tell it to build several steps in three calls: one `apply_edits` that adds and connects them, one `list_references` naming them, and one `apply_edits` that writes their configs. On a five-step build this removed the step-by-step path a third of runs took, which used twice the tokens. `set_condition` now names the step a Condition reads a path from when two steps above it offer that path.
