---
"@wfgraph/core": patch
---

A Cancel Event now reaches the runs of a workflow whose published graph no longer passes the checks a start runs, such as one naming an integration that was deleted after Publish. Such a workflow stops opening new runs, and its runs in flight still take the Canceled outlet when their Cancel Event arrives, where before every Cancel Event for it was skipped and those runs carried on.
