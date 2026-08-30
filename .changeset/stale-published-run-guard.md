---
"@wfgraph/core": minor
"@wfgraph/client": minor
"@wfgraph/shared": minor
---

`workflow.execute` takes an optional `expected` of `{ versionId, mode }`. A
published run carries what the run dialog displayed, and the server refuses the
run with a `CONFLICT` when the published version or the workflow's Published
mode has moved since. Without it, a dialog left open across a publish or a mode
change starts a run against a graph or a set of recipients nobody saw. A draft
run sends no `expected`, because it reads the canvas. The editor sends the key
for every published run it offers.

A draft snapshot is reused for a repeated run of an unchanged canvas only once
an Execution references it. An unreferenced snapshot belongs to the request that
inserted it, which can still release it when a later gate refuses the start, so
handing that row to a concurrent request would let one run pin a version id the
other is about to delete.
