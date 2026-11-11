---
"@wfgraph/core": minor
---

Every build-tool write now answers `newIssues`: the validation issues the draft has after the write that it did not have before, each with `blocksPublish`, `kind`, `message` and the step's id and label. A client no longer needs a `validate_workflow` call after each step to learn what an edit left to fix.
