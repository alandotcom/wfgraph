# 12. Publish-gated workflow versions pin runs to immutable graphs

Date: 2026-08-03

## Status

Accepted.

## Context

A run already kept the graph it started with on its Inngest event payload, so
execution against an edited draft stayed correct. Every reader of that run —
the run panel, logs, status overlays — resolved node ids against the live
`workflows.graph` column instead. A deleted node left log rows pointing at
nothing, and the canvas painted the wrong shape.

Inngest's own versioning model is step-id memoization and, for incompatible
handler rewrites, a new function id with event routing. That answers how
deployed _code_ evolves under parked runs. It does not answer which authored
graph an Execution started against, or what catalog surface that graph was
checked against.

Pinning the graph alone still leaves `actions.stepFor(actionType)` resolving
against whatever build is awake when a run resumes. A catalog fingerprint on
the version detects that surface changing; it does not freeze host handler
bodies.

## Decision

Workflows keep an editable draft on `workflows.graph`. Publish mints an
immutable `workflow_versions` row (or reuses one whose graph digest and catalog
fingerprint match), rewrites the event subscription index from that graph, and
points `workflows.published_version_id` at it. Draft saves never rewrite
subscriptions.

Every new Execution stores `workflow_version_id`. Starts load the published
version; a never-published workflow is refused. The Inngest event still carries
the graph for durability, and also carries the version id and catalog
fingerprint. Readers load the version's graph. When an action node resolves and
the live catalog fingerprint differs from the pinned one, the node fails once
with a clear error.

Publish also refuses unreachable subtrees and a Canceled branch with no Cancel
Event declared.

Kill-stuck-run remains a separate concern from Cancel Event routing
(ADR-0007). Inngest function-id cutovers remain an engine/deploy concern, not
a publish concern.

## Consequences

- Event and manual starts require a published version.
- The run panel can paint the graph a run walked even after the draft diverges.
- A deploy that changes the assembled catalog fails waking action nodes rather
  than silently resolving against a different surface.
- Host code changes with an unchanged catalog still follow Inngest step
  memoization; major engine rewrites still use Inngest's new-function pattern.

## Amendment, 2026-08-05: Canceled branch without Cancel Event is inactive, not refused

Publish still refuses unreachable subtrees. A Canceled branch with no Cancel
Event declared is no longer refused: the engine never enters that branch
(`CancelBoundary` buys no boundary read without a Cancel Event), and the editor
mutes it instead. The Decision paragraph above that named both refusals is
superseded for the Cancel Event half only.

## Amendment, 2026-08-07: versions outside the retention window are swept at publish

This ADR left `workflow_versions` append-only by omission, and #35 reported the
consequence: a value an author pasted into a node config, then removed and
republished, sat in an old version row indefinitely with nothing bounding the
table.

A publish now sweeps that workflow's versions outside the newest ten, deleting
only rows no Execution pins and no workflow names as published. Both foreign
keys act destructively — `workflow_executions.workflow_version_id` cascades,
`workflows.published_version_id` sets null — so the predicate makes both actions
unreachable rather than merely avoiding them.

"Readers load the version's graph" is unchanged: a version an Execution pins is
never a candidate, so the run panel's fetch by pinned id cannot miss. What the
sweep narrows is the lifetime of a version nothing ever asks for.

The sweep sits at publish because publish is the only event that grows the
table, which bounds it continuously with no scheduler. One consequence worth
naming: content-hash dedupe misses on a graph whose row was swept, so
republishing it mints a new row and advances the version counter. Nothing
attaches meaning to version-number density.

## Amendment, 2026-08-17: readiness is asked at publish and nowhere else on a write path

This ADR said Publish "also refuses unreachable subtrees", which read as an
addition to a battery every graph write already ran. That battery is now split,
and publish holds all of the half worth holding.

`prepareGraphSave` asked required fields, Events, Event Split outlets, template
references and connections on every draft save. A half-built node is the
ordinary state of an editor session, so the common case of building a workflow
was a refused write; the editor suppressed that 400 for autosaves, which made it
a silent one, and a reload discarded the work. The save now asks only what has to
be true of a graph stored in a row: that it parses, and that the CEL on it agrees
with the model that produced it. Everything else moved to `checkPublishReadiness`
in `publish-checks.ts`, beside the unreachable-subtree check this ADR already put
there.

Nothing lost a guard, because of two properties this ADR established. No run
reads the draft column: both start paths load the published version row and
refuse when there is none. And publish is the sole writer of the event
subscription index, so an Event cannot reach a draft either. Publish is therefore
the last point at which a refusal still costs the author nothing, and the first
at which one is worth anything. Two of the moved checks -- Event Split outlets
and template references -- are in no run preflight, so the save battery was their
only home outside publish. Publish ran them before this change and runs them
still; what stopped running them is create, patch, duplicate and the editor's
draft write.

A draft save also stops costing a query. Nothing left in that path reads the
catalog or the integration rows, so an autosave can no longer be refused by a
connection someone deleted in another tab.

The editor carries the other half: validation runs continuously against the
graph, broken nodes wear a badge, and the toolbar counts them, so "it will not
publish" is something the author reads while building rather than learns at the
gate.

## Amendment, 2026-08-23: publication history is durable and chronological

The editor gained version history, structural comparison, and restore as draft.
Those capabilities require every published revision to remain addressable after
its runs finish. The retention sweep from the 2026-08-07 amendment is removed,
and publication no longer reuses a row with matching content.

Each confirmed Publish mints the next monotonic version. Publish refuses the
current version's semantic graph, where node position and measured geometry do
not change meaning. Publishing content restored from an older revision still
mints a new version. Versions removed before this amendment cannot be recovered.

History is paginated newest first. Comparison runs on the server against the
exact draft graph supplied by the editor, then returns redacted graph snapshots
and deterministic node, field, and connection changes. Restore copies one
historical graph into the editable draft. It does not move the published pointer
or rewrite event subscriptions, so new starts continue to use the current
published version until the restored draft is published.

Durable history retains historical configuration values for the lifetime of the
workflow. Responses apply the same graph redaction policy as pinned run graphs.
This retention and redaction policy supersedes the bounded-storage decision in
the 2026-08-07 amendment.
