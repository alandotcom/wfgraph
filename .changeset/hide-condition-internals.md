---
"@wfgraph/client": patch
"@wfgraph/core": patch
---

Hide stored condition paths, compiled CEL expressions, and the Wait node's internal `hops` output from workflow authoring. Existing references to `hops` remain valid.
