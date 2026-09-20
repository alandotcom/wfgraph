---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

Add a maximum-lateness policy to time-based Wait steps. A Wait can now continue when its target is only slightly late, skip the branch after a configured duration, and evaluate that limit before applying its allowed-hours window.
