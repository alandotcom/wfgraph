# Lifecycle Rules replace the Routing Policy

The Routing Policy (ADR 0001) mapped every Event Type to Start, Replace,
Cancel, or Ignore. In use, the four verbs hid three rules the editor never
showed: a resume won over a start, an Ignore still woke waits, and Replace
compressed "cancel the entity's runs, then start a new one" into a word with
an invisible blast radius. The Workflow Builder could not answer "what happens
when this event arrives" from the table alone.

The Workflow Builder now declares a run's lifetime as Lifecycle Rules on the
workflow's entry node: which Events start a run, which Events cancel it, and
how many runs may exist per Entity Value (newest wins, first wins, or
unlimited). Replacement is newest-wins Concurrency doing its job, so Replace
stops being a word. An Event with no assigned role does nothing to runs, and
waits subscribe to Events on their own, so Ignore stops being a word too.

Cancellation became control flow. The entry node carries two outlets, Started
and Canceled. A Cancel Event routes every in-flight Execution with an equal
Entity Value to the Canceled outlet at its next step boundary, inside the same
Execution, so the branch reads the run's earlier outputs and the canceling
payload. The branch is terminal. A run displaced by newest-wins ends quietly
with status superseded and fires no outlet, because a reschedule is routine
and cleanup that fires on it sends wrong messages.

The authored trigger dissolved. Once Events carry the Correlation Path and the
Workflow Builder owns Concurrency, a trigger definition had nothing left to
own. The Event Author defines Events; every lifecycle decision is the
builder's. That ownership split is the part of ADR 0001 this decision keeps.

## Considered Options

- **Keep the four-verb table with clearer copy** rejected: the verbs stay
  overloaded and the precedence rules stay hidden; better sentences describe
  the confusion without removing it.
- **A Replaced outlet beside Canceled** rejected: supersession firing a
  cleanup branch invites the wrong-message bug (every reschedule sends the
  cancellation email unless the builder remembers to branch on cause). A
  workflow that wants reschedule messaging starts on the reschedule Event or
  handles it in a separate workflow.
- **Interruptible lifecycle branches** rejected: a jump from one lifecycle
  branch into another reintroduces the state-dependent surprises this
  decision removes.
- **Hard-kill cancellation mid-step** rejected: killing the durable run where
  it stands loses the memoized context that makes the Canceled Branch useful;
  the next step boundary is deterministic and keeps every landed output.

## Consequences

- Precedence is one fixed, stated order: Lifecycle Rules first, then delivery
  to the Wait Subscriptions of surviving runs. The resume-wins-over-start rule
  and the policy-wins warning both retire.
- One Event never holds the start role and the cancel role in the same
  workflow; the editor rejects the configuration instead of picking a winner.
- Execution statuses gain superseded, beside completed, canceled, and failed.
- `createTrigger` and the trigger registry retire with no compatibility shim.
  Events own the Correlation Path; the builder supplies one in the panel when
  an imported Event declares none. Entity agreement across Events is by value,
  and the editor shows the pairing.
- The webhook trigger becomes an intake channel that produces Events; schedule
  and manual runs become start sources on the Lifecycle Node.
- One Event per name. An app defines `appointment.created` and
  `appointment.canceled` as separate Events; an existing bus that sends one
  umbrella name declares each Event with a source filter, and the intake layer
  does the narrowing. The panel's lists hold plain Event names, which keeps
  the one-role rule a set intersection.
- A start with no payload (schedule, manual) uses the workflow itself as its
  Entity Value, so newest-wins supersedes a still-running tick and first-wins
  skips a tick while one runs.

## Amendment, 2026-07-31: the run carries the Event it arrived on

The implementation had narrowed "which Events start a run" to one name, on the
grounds that everything downstream of the entry node is written against one
payload and a second Start Event would leave a builder addressing only the
fields the two share. That reasoning held while a node could be offered nothing
but the intersection.

Three changes remove it. A rule about a field the run's payload lacks now reads
false on its own, so offering a field only some Events declare breaks nothing. A
node is offered the union of the payloads that can reach it, sectioned by the
Events declaring each path. And the Event a run arrived on travels as its own
CEL root, `event.name`, so a rule can select between them; a Condition node
behind the Canceled outlet needed that already, since one outlet serves every
Cancel Event.

`startEvents` is a list. The one-role rule stands as the intersection of the two
lists. Concurrency stays one setting for the whole workflow, so under newest-wins
every Start Event displaces the in-flight run for that entity, which is what
makes a reschedule rebuild a reminder chain rather than needing a second
workflow of its own.

## Amendment, 2026-08-01: a branch invocation is killed, and the run is told

"Hard-kill cancellation mid-step" was rejected above because killing the durable
run where it stands loses the memoized context the Canceled Branch is built on.
That reasoning holds for the run. It does not reach a waiting branch, which
ADR-0011 made a durable run of its own: the work behind a Wait now sits in an
invocation that the run's own boundary reads cannot stop.

A Cancel Event therefore kills those invocations, on an event distinct from the
one that cancels a run. The substance of the decision is untouched: every landed
output lives in the run-log rows, and the run itself survives to read the flag at
its next boundary and enter the Canceled outlet with that history in hand. What
the kill ends is work that would otherwise carry on for a run already claimed,
and the run is what closes the rows those invocations left open.

## Amendment, 2026-08-30: an integration-owned Event names a Connection

An Event may belong to an integration. When it does, the Lifecycle Rules name
the Connection that Event arrives through, stored as `connectionIds` on the
same grain as `correlationPaths`. A Wait names its own `connectionId` per
subscription. Publish refuses an integration-owned Start, Cancel, or Wait
Event that names none, rather than fanning in across every Connection of that
type.

The Connection is delivery metadata, not payload. Intake stamps `connectionId`
on Inngest event `data` (v4 does not persist `event.user`) and the listener
strips it before decode. Matching is the stored id on Lifecycle Rules and Wait
Subscriptions. A start on the wrong Connection is `waits_only`. The
subscription index stays keyed by Event name.

## Amendment, 2026-08-30: one Connection per integration in the editor

The editor offers one Connection picker, and one webhook URL, per integration
named by the rules, not per Event. Two Resend Start Events share the Resend
Connection and paste the same Connection-addressed URL. The stored
`connectionIds` map still keys by Event name so matching stays on the arrival;
choosing a Connection stamps every named Event of that integration.
