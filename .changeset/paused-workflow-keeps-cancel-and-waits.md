---
"@wfgraph/core": patch
---

A paused workflow now stops new starts and nothing else. A Cancel Event still claims its runs in flight and an Event still wakes their Waits, where before a pause dropped both deliveries and the inbox row still settled as delivered. A start that arrives after the pause opens no run, even when its delivery was already under way when the workflow was paused.
