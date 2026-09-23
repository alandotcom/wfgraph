---
"@wfgraph/core": patch
---

Resolve nonexistent local Wait timestamps and allowed-hours starts to the first
valid time after a clock-forward transition, while keeping adjusted deadlines
inside the configured window.
