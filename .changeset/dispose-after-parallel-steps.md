---
"@wfgraph/core": patch
---

`app.dispose()` now finishes promptly after a run whose action steps ran in parallel. Before this change it never finished once a fan-out or the two arms of a join had run in the process.

In async step mode, Inngest never settles the `step.run` promise of a step it planned in parallel, so the invocation that planned the steps stays parked. Every action ran inside an uninterruptible Effect region that included that wait, and disposal waits for every fiber the app runtime started, so the parked invocation held disposal open forever. The region is gone. Disposal now interrupts a parked invocation at once, and it waits only for step bodies Inngest has started, so persistence stays open until those bodies finish.
