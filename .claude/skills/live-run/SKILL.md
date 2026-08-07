---
name: live-run
description: Drive a real workflow run against the local stack and read what actually happened. Use when a change touches the engine, the Wait node, cancellation, the Inngest functions, or anything whose behaviour is decided by Inngest's executor rather than by WfGraph's own code, and a vitest suite therefore cannot settle the question. Triggers on "verify against inngest dev", "drive a real run", "measure the timing", "check it end to end", or a claim about when a run wakes, resumes, retries, or is cancelled.
---

# Driving a live run

The test suite drives the engine through `createInMemoryWorkflowRuntime` and
`driveWithReplay`. Both model Inngest rather than being it, so anything the
executor decides is a question they answer from a stated model. When the change
is to that model, or to what depends on it, the answer has to come from a real
run.

Read the whole of this file before starting. The order below matters, and three
of the steps have a trap in them.

## What a live run can settle that a test cannot

- When a run wakes, and what a pause costs the branches beside it.
- What `step.invoke` resolves to for a child that completed, was cancelled, or
  failed.
- What Inngest adds to an event on the way through.
- Whether a function registers, and under which id.
- What a row holds after a real replay, which is where a duration or a status
  written by the wrong attempt shows up.

Everything else belongs in vitest, which is faster and repeatable.

## 1. Start the stack

```bash
(pnpm run dev > /tmp/wfgraph-dev.log 2>&1 &)
```

Three processes: the example app on 4017, Vite in `packages/client`, and
`inngest dev` on 8388. Postgres is expected on 55437 already, from
`docker-compose.yml`.

**Trap.** A backgrounded `pnpm run dev` returns at once, and the harness reports
it as finished while the three processes keep running. Wait for readiness rather
than for the command:

```bash
until curl -sSf -o /dev/null http://localhost:4017/api/extensions; do sleep 2; done
```

Then give the Connect handshake another few seconds. The log line to look for is
`Inngest Connect worker ready`. A run enqueued before that handshake sits
unclaimed.

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

Create it through the RPC rather than with SQL, so the graph is validated and
its Event subscriptions are written:

```bash
node /path/to/scratchpad/make-probe.mjs "Two waits probe"
```

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
until [ "$(psql "$WFGRAPH_DB" -t -A -c \
  "select status from _workflows.workflow_executions where id='<exec>';")" = "completed" ]
do sleep 3; done
```

Poll for what the case is about, rather than for the run ending. Two examples
that read well: `count(*) ... where status='waiting'` equals the number of Waits,
for "both branches are parked"; a node's row reaching `success`, for "this branch
landed on its own target".

## 5. Read the trace

WfGraph's tables live in the `_workflows` schema.

```bash
WFGRAPH_DB="postgresql://workflow:workflow@localhost:55437/workflow_builder"

psql "$WFGRAPH_DB" -c "select node_name, status,
  to_char(started_at,'HH24:MI:SS') started,
  to_char(completed_at,'HH24:MI:SS') completed, duration, output
  from _workflows.workflow_execution_logs
  where execution_id='<exec>' order by timestamp;"

psql "$WFGRAPH_DB" -c "select status, error, duration
  from _workflows.workflow_executions where id='<exec>';"

psql "$WFGRAPH_DB" -c "select node_name, status
  from _workflows.workflow_wait_states where execution_id='<exec>';"
```

`duration` is milliseconds as text. The node rows are what a timing claim rests
on: a wait's duration is how long the run was parked, and the row of the node
behind it says when the branch resumed.

## 6. Read what Inngest did

The run log says what WfGraph recorded. This says what the executor actually ran,
which is the only place a claim about invocations can be settled.

**Trap.** The dev server holds its database open, so copy it first.

```bash
sqlite3 "file:.inngest/main.db?mode=ro" ".backup /tmp/x.db"
sqlite3 /tmp/x.db "select json_extract(attributes,'\$.\"_inngest.step.name\"'),
  json_extract(attributes,'\$.\"_inngest.step.op\"'),
  json_extract(attributes,'\$.\"_inngest.started_at\"')
  from spans where run_id='<run>' and
  json_extract(attributes,'\$.\"_inngest.step.name\"') is not null
  order by start_time;"
```

`executor.execution` spans are function invocations. The gap between two of them
is what proves a branch stalled, and their count is what proves how many runs a
graph took.

## 7. Clean up

Every probe leaves rows behind, and the next session reads the workflow list.

```bash
pkill -f "inngest dev"; pkill -f "concurrently --kill-others-on-fail"
psql "$WFGRAPH_DB" -c "delete from _workflows.workflows where id in ('<id>');"
```

Deleting the workflow cascades to its executions, logs and wait states.

## Reporting what you measured

State the numbers, the run id, and the time, the way `docs/adr/0011` and the
comment on issue #14 do. A measurement with no id attached cannot be checked by
the next person, and a claim about Inngest with no measurement behind it is the
thing this skill exists to replace.

If a measurement contradicts a comment in the tree, the comment is what changes.
`advanceToLastPause` and `endTimersDueNow` in `engine/testing/replay-runtime.ts` state
the executor policy the suite models: a measurement that disagrees with either
is a bug in the model, and every test standing on it is then standing on
something false.
