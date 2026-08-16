---
"@wfgraph/core": minor
---

Name a run and its steps in the Inngest UI.

Every workflow executes on one Inngest function, so the dashboard labelled every
run "Workflow run" and every trace row carried a memoization id built from an
opaque node id. Two things change that:

- A run attaches its own identity as Inngest run metadata under the
  `userland.wfgraph` kind: the workflow's name and id, the execution id, the run
  mode, the triggering event, the workflow version and the node count, plus the
  entry node on a branch run. It is written inside one memoized step, so it
  survives a replay and costs no extra request. A refused write is logged and
  the run continues.
- Each durable step now carries a display name beside its id, so a trace reads
  `Post to Slack: post` rather than `node:vMVCWuW-OmRDEhJok5pfu:post`. Every step
  id is unchanged, so memoization behaves exactly as before.

The Inngest client is now built with `metadataMiddleware()` from
`inngest/experimental`, which is what makes the metadata surface reachable. The
Inngest Dev Server shows the Metadata tab from v1.17.0.
