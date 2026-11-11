---
"@wfgraph/core": patch
---

A durable step's answer is now held to `runner.maxStepValueBytes`, 1 MiB of JSON by default. A step that answers more fails its node at once, with no retry, and the node's error names the step and the size, never the value. Every pass of a run reads back every step's stored answer, so an unbounded answer made each pass of a long run slower.
