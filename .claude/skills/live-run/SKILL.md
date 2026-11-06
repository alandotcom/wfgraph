---
name: live-run
description: Drive a real workflow run against the local stack and read what actually happened. Use when a change touches the engine, the Wait node, cancellation, the database executor's worker loop, Event delivery through Inngest, or anything whose behaviour shows only in a running app on the wall clock, so a vitest suite cannot settle the question. Triggers on "drive a real run", "measure the timing", "check it end to end", "verify against inngest dev", or a claim about when a run wakes, resumes, retries, or is cancelled.
---

# Driving a live run

Runs execute on the database executor: the worker loop the example app starts
claims a run's schedule row, replays its body against the step memo, and
releases the row. Inngest delivers Events to the app and runs no workflow body.
The test suite drives the engine through `createInMemoryWorkflowRuntime` and
`driveWithReplay` on a virtual clock, so a question about the wall clock, about
the loop's wakes, or about how an Event reaches a run has to be answered by a
real run.

Read the whole of this file before starting. The order below matters, and three
of the steps have a trap in them.

## What a live run can settle that a test cannot

- When a run wakes after a Wait, a Cancel or an Event, measured by the wall
  clock, and how late the worker loop claims it.
- What Inngest adds to an Event on the way through, and whether the Event's
  forwarder function registers, and under which id.
- What a row holds after a real replay, which is where a duration or a status
  written by the wrong pass shows up.

Everything else belongs in vitest, which is faster and repeatable.

## 1. Start the stack

```bash
(INNGEST_DEV_PORT=8388 pnpm run dev > /tmp/wfgraph-dev.log 2>&1 &)
```

Three processes: the example app on 4017, Vite in `packages/client`, and
`inngest dev`. That last one takes free ports unless it is told otherwise, which
is what `INNGEST_DEV_PORT` above is for: the curl in step 3 needs a port known in
advance. Nothing else has to be running: the app opens `examples/wfgraph.sqlite`
and creates its schema on first boot.

**Trap.** A backgrounded `pnpm run dev` returns at once, and the harness reports
it as finished while the three processes keep running. Wait for readiness rather
than for the command. Probe the public login page: `/api/extensions` is protected
and returns 401 until the request carries a demo-login session.

```bash
until curl -sSf -o /dev/null http://localhost:4017/login; do sleep 2; done
```

Open `http://localhost:5173/login` (or Vite's printed port) and sign in with a
demo account before calling protected API routes. Every account uses `password`;
`editor` has the permissions a live run needs. Set `WFGRAPH_DEMO_USER=admin` in
`.env.local` to skip the login page in development.

The log line `Worker loop started` says the executor is running, and a manual
run started through the RPC needs nothing else. An Event sent to the dev server
reaches the app only after the Connect handshake: wait for `Inngest Connect
worker ready` before sending one, or it sits undelivered.

## 2. Build a probe workflow

Write one for the question. The saved workflows belong to whoever is using the
app, and a graph shaped for a measurement is clearer than one bent to it.

`scripts/make-probe.mjs` beside this file is a working builder to copy into the
scratchpad and edit. Two things about the graph format cost a session an hour
each:

- The serialized graph is graphology's, so every node and edge is
  `{ key, attributes }` rather than a plain object. `packages/shared/src/graph/`
  owns the shape.
- Use `appointments/cancel` for a node that has to do something. It is the
  example app's own action, it does its work inside `step.run`, and it reaches
  nothing outside the process. **Never put a `twilio/*` or any other integration
  action in a probe**: those send real messages to real numbers.

Create it through the RPC rather than with SQL, so the graph is validated:

```bash
node /path/to/scratchpad/make-probe.mjs "Two waits probe"
```

**Trap.** `workflow/create` writes no Event subscriptions. Only `workflow/publish`
does, so an unpublished probe receives no Start Event, no Cancel Event and no
wait Event. Publish the draft (`expectedDraftRevision: 1`,
`expectedPublishedVersionId: null` on a fresh probe) before sending anything,
and read the `workflow_event_subscriptions` rows to confirm. `workflow/getById`
takes `workflowId`.

## 3. Trigger a run

```bash
curl -s -X POST http://localhost:4017/api/rpc/workflow/execute \
  -H 'content-type: application/json' \
  -d '{"json":{"workflowId":"<id>","eventName":"app/appointment.created",
       "input":{"occurredAt":"2026-08-01T19:00:00.000Z",
                "appointment":{"id":"probe-1","status":"scheduled",
                               "startsAt":"2026-08-10T19:03:00.000Z",
                               "patientName":"Alan"}}}}'
```

The Start Event's schema is strict, so all four fields are required. The answer
carries the `executionId` every query below is keyed by.

To send a host Event instead, which is what drives cancellation and event waits,
post it to the dev server. Any key works in dev:

```bash
curl -s -X POST http://localhost:8388/e/dev_key -H 'content-type: application/json' \
  -d '{"name":"app/appointment.canceled","data":{...}}'
```

The Event has to carry the same Correlation Path value as the run it concerns,
which for the example app's appointments is `appointment.id`.

## 4. Wait for the state you are measuring

**Trap.** The harness refuses a bare `sleep` long enough to be useful. Poll for
the condition instead, in a `run_in_background` Bash call or an until-loop:

```bash
WFGRAPH_DB="file:examples/wfgraph.sqlite?mode=ro"

until [ "$(sqlite3 "$WFGRAPH_DB" \
  "select status from workflow_executions where id='<exec>';")" = "completed" ]
do sleep 3; done
```

Poll for what the case is about, rather than for the run ending. Two examples
that read well: `count(*) ... where status='waiting'` equals the number of Waits,
for "both branches are parked"; a node's row reaching `success`, for "this branch
landed on its own target".

## 5. Read the trace

The example app's tables are unqualified, in one SQLite file. It is opened in
WAL mode, so a second reader is free to run while the app holds it.

```bash
WFGRAPH_DB="file:examples/wfgraph.sqlite?mode=ro"

sqlite3 -box "$WFGRAPH_DB" "select node_name, status,
  strftime('%H:%M:%S', started_at/1000, 'unixepoch') started,
  strftime('%H:%M:%S', completed_at/1000, 'unixepoch') completed, duration, output
  from workflow_execution_logs
  where execution_id='<exec>' order by timestamp;"

sqlite3 -box "$WFGRAPH_DB" "select status, error, duration
  from workflow_executions where id='<exec>';"

sqlite3 -box "$WFGRAPH_DB" "select node_name, status
  from workflow_wait_states where execution_id='<exec>';"
```

**Trap.** Every timestamp column is an integer of epoch milliseconds, so it
reads as a large number until `strftime` divides it by 1000. `duration` is the
exception: it is milliseconds as text, the way Postgres held it.

The node rows are what a timing claim rests on: a wait's duration is how long
the run was parked, and the row of the node behind it says when the branch
resumed.

## 6. Read what the executor did

The run log says what Workflow Graph recorded. The schedule row and the step memo
say what the executor did with the run: the schedule row exists while the run is
in flight and records when it is next due, and each memo row is one durable step.
The terminal write deletes both, so read them while the run is still open.

```bash
WFGRAPH_DB="file:examples/wfgraph.sqlite?mode=ro"

sqlite3 -box "$WFGRAPH_DB" "select state, attempt, running_step_id,
  strftime('%H:%M:%f', wake_at/1000.0, 'unixepoch') wake_at, worker_id, last_error
  from workflow_execution_schedule where execution_id='<exec>';"

sqlite3 -box "$WFGRAPH_DB" "select s.step_id, s.status, s.failures,
  strftime('%H:%M:%f', s.created_at/1000.0, 'unixepoch') created
  from workflow_execution_steps s
  join workflow_execution_schedule c on c.id = s.schedule_id
  where c.execution_id='<exec>' order by s.created_at;"
```

The app's log under the `executor` category carries a record for each pass that
failed and each claim the database refused, which is where a stalled loop
shows. When the question is about Event delivery, the Inngest dev server's UI
on `INNGEST_DEV_PORT` lists each Event and the forwarder run that recorded it
in `workflow_event_inbox`, whose row's `status` says whether the worker loop
delivered it.

## 7. Clean up

Every probe leaves rows behind, and the next session reads the workflow list.

```bash
pkill -f "inngest dev"; pkill -f "concurrently --kill-others-on-fail"
sqlite3 examples/wfgraph.sqlite "PRAGMA foreign_keys = ON;
  delete from workflows where id in ('<id>');"
```

Deleting the workflow cascades to its executions, logs and wait states.

**Trap.** `PRAGMA foreign_keys` is per connection and the `sqlite3` shell opens
with it off, so the delete above leaves every child row orphaned without it. The
pragma also has to precede the delete on the same invocation. Dropping the whole
file is the other way to clean up, and the app rebuilds the schema on its next
boot.

## Reporting what you measured

State the numbers, the run id, and the time, the way `docs/adr/0021` does. A
measurement with no id attached cannot be checked by the next person.

If a measurement contradicts a comment in the tree, the comment is what changes.
`driveWithReplay` in `engine/testing/replay-runtime.ts` states the wake policy
the suite models, that a run wakes when any one of its parks resolves: a
measurement that disagrees with it is a bug in the model, and every test
standing on it is then standing on something false.
