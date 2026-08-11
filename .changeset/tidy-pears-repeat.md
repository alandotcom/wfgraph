---
"@wfgraph/client": patch
"@wfgraph/core": patch
"@wfgraph/plugins": patch
---

Each package now ships its own README, so its npm page describes what it is rather than
offering to let someone add one, and declares `engines.node` at the Node 24 floor the repo
already builds against, so an install on an older runtime warns instead of failing later.
