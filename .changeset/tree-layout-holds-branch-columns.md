---
"@wfgraph/client": patch
---

Auto-layout keeps a branch in its own column. An outlet a Lifecycle or Condition
node draws now holds its column whether or not anything is wired to it, so a
workflow with no Cancel branch still reads as a tree and wiring that branch later
moves nothing already placed. A Group frame no longer sends the graph to the
dagre fallback either: a rank is now as tall as the tallest node standing in it,
so a frame takes a rank of its own and the chain around it stays centred.
