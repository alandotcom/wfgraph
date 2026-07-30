# Routing Policy is owned by the Workflow Builder

Superseded by [ADR 0007](0007-lifecycle-rules-replace-the-routing-policy.md),
which keeps the ownership split (authors supply vocabulary, builders own
policy) and retires the per-event verb table.

Custom triggers originally routed incoming payloads through author-written
lifecycle callbacks (`onStart`/`onRestart`/`onStop` on `createTrigger`), while
the webhook trigger exposed a parallel builder-configured system with different
names (create/update/delete CSV lists). The same concept lived in two places
with two vocabularies and two owners. We decided the Workflow Builder owns
routing everywhere: each workflow carries a Routing Policy mapping every Event
Type to Start, Replace, Cancel, or Ignore, and the Trigger Author supplies only
vocabulary (payload schema, mandatory `correlationIdPath`, optional
`eventTypePath` falling back to the Inngest event names). Authored routing was
policy masquerading as vocabulary: whether a reschedule replaces a run is a
per-workflow decision, and one trigger definition cannot answer it for every
workflow built on it.

## Considered Options

- **Author-owned routing (status quo)** rejected: the routing decision was
  invisible in the editor, and two workflows on one trigger could not differ.
- **Author defaults with builder overrides** rejected: two sources of truth
  for one decision recreates the legibility problem the change removes.

## Consequences

- `createTrigger` loses `lifecycle` with no compatibility shim, a breaking
  change to the published `@rova/core/plugin` surface.
- The webhook trigger's create/update/delete config is retired; every trigger
  type renders the same Routing Policy table.
- Cancel and Replace widen to target every in-flight Execution for the
  Correlation Key, closing the gap where only runs parked at a Wait node could
  be cancelled.
- When an Event Type is both mapped to Replace or Cancel and listed on a Wait
  node, the policy wins; the editor warns rather than blocks. An Event Type
  mapped to Ignore still wakes matching waits.
- A fresh policy maps everything to Ignore; the editor warns while nothing
  maps to Start or Replace.
