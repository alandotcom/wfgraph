---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

A build-agent or MCP write no longer re-runs full auto-layout. Steps already on the canvas keep their positions, including ones a person moved by hand, and each step the write added is placed below the step it runs after (or above the step it leads to) and moved right until it overlaps nothing. A graph with no positioned step is still laid out whole.
