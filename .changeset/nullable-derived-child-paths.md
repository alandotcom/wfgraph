---
"@wfgraph/core": patch
---

Mark flattened child paths nullable when a parent object is null or an array
index may be missing, so the editor offers is-empty operators on those paths.

A derived path is reachable only when every ancestor on it is present. The
reader already marked a nullable object and a top-level scalar correctly, but
children under `nested.date` or `list[0].uuid` stayed required. Array `[0]`
children stay required only when the array declares `minItems >= 1`.
