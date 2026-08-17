---
"@wfgraph/client": patch
---

Drop the `Temporary` edge component. Nothing built an edge of that type, so the
canvas registered a component it could never resolve to.
