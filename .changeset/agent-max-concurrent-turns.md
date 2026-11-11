---
"@wfgraph/core": minor
---

`agent.maxConcurrentTurns` sets how many build agent turns one process streams at once, across everyone using the editor. It defaults to 4, the limit that was fixed before, and startup refuses a value that is not a positive integer.
