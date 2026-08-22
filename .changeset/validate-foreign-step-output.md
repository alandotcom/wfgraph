---
"@wfgraph/core": patch
---

Validate non-Effect step and action outputs through `~standard.validate`, so undeclared keys no longer pass through when the library strips them and a mismatched answer fails the node once.
