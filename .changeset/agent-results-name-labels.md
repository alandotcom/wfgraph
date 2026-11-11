---
"@wfgraph/core": patch
---

Build-tool results and refusals now name a step by its canvas label with its id beside it, such as `"Score applicant" (n_123)`, where they printed a bare id, including the refusal of an edge that would make a loop.
