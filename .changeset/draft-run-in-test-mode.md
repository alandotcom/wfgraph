---
"@wfgraph/core": minor
---

`workflow.execute` accepts `graph: "draft"`, which runs the graph on the
workflow's canvas. The draft passes the same checks a published start runs, is
frozen as a draft snapshot version, and the run is pinned to that row. A
workflow that has never been published can therefore run, and an edit can be
tried without publishing it.

A draft run always reaches test recipients. Its response, its Execution row, its
Inngest event and its audit rows record `runMode: "test"` whatever the
workflow's mode is, because nobody has reviewed the graph it executes. The
workflow's own mode is the Published mode alone. It decides who Events and
manual runs of the published version reach, and a draft run ignores it.
Concurrency keys its in-flight set on the mode, so a draft run sits beside a live
run of the same entity instead of superseding it.

Every other rule a manual start follows is unchanged, including the pause gate,
the manual-start rule, and the Start Event a run stands in for.

The editor sends the canvas before it starts a draft run. Run draft flushes the
autosave queue, so an edit made shortly before the click is part of the run. A
refused save stops the run and reports the reason.
