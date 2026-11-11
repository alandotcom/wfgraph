---
"@wfgraph/core": minor
---

A `defineAction` handler now runs inside one durable step of its node, so a handler that answered once is not called again for that node of that run, whether or not it calls `step.run`. Before, a host handler ran again on every pass of the run, and a side effect written outside `step.run` repeated after every Wait, retry and restart. `step.run` inside a handler keeps memoizing each named step, so a handler whose step threw is called again on the retry and resumes past the steps that finished. A throw outside any `step.run` still fails the node once, and is now also what every later pass answers. Integration actions written with `defineIntegration` are unchanged and still remember only what their handler puts in `step.run`. Each host action node writes one more row to the run's step memo.
