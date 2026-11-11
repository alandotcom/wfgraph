---
"@wfgraph/core": patch
---

A step that is still running when a step on another branch of the same run fails now records its result, so the retry does not run it again. Before, a Slack post that landed while a sibling lookup failed with a 502 was posted a second time on the retry.

Stopping a run's pass, as `dispose()` does after its drain or a Worker tick does at its budget, now also stops the steps the pass is running: a step written as an Effect is interrupted, which aborts the request it has in flight. A step written as a plain Promise cannot be stopped, so its run is held back for one lease before another worker may claim it, and the step is never run twice at once.
