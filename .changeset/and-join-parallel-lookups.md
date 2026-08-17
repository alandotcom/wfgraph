---
"@wfgraph/core": minor
"@wfgraph/client": minor
"@wfgraph/shared": minor
---

Allow AND-joins: two parallel action nodes can both feed one next step. Fan-out was already concurrent; saving and the canvas now accept multi-incoming edges when every predecessor completes successfully, with Wait-on-arm, Started↔Canceled, and exclusive-branch joins still refused.
