---
"@wfgraph/core": minor
---

A test-mode workflow can run the graph on its canvas. `workflow.execute` with
`graph: "draft"` reads the draft, puts it through the same checks a published
start runs, freezes it as a draft snapshot version, and pins the run to that
row, so a workflow nobody has published is runnable and publishing to test no
longer decides what a production Event runs. A live workflow is refused: its
runs stay on the version that was reviewed. Every other rule a manual start
answers to holds unchanged, including the pause gate, the manual-start rule, and
the Start Event a run stands in for.

The editor sends the canvas before it starts such a run: a test-mode Run flushes
the autosave queue and takes its draft-or-published decision from what that
write answered, so an edit made a moment before the click is in the run rather
than a debounce window behind it. A refused save stops the run and says so.
