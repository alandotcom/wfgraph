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
