---
"@wfgraph/core": minor
---

A workflow can run the graph on its canvas. `workflow.execute` with
`graph: "draft"` reads the draft, puts it through the same checks a published
start runs, freezes it as a draft snapshot version, and pins the run to that
row, so a workflow nobody has published is runnable and an edit can be tried
without publishing it.

Such a run always goes to test recipients. Its response, its Execution row, its
Inngest event and its audit rows all record `runMode: "test"` whatever the
workflow's mode says, because the graph it travels is one nobody reviewed. The
workflow's own mode is now the Published mode alone: it decides what Events and
manual runs of the published version send to, and a run of the canvas never
reads it. Concurrency keys its in-flight set on the mode, so a run of the draft
sits beside the live run of the same entity rather than superseding it.

Every other rule a manual start answers to holds unchanged, including the pause
gate, the manual-start rule, and the Start Event a run stands in for.

The editor sends the canvas before it starts such a run: Run draft flushes the
autosave queue, so an edit made a moment before the click is in the run rather
than a debounce window behind it. A refused save stops the run and says so.
