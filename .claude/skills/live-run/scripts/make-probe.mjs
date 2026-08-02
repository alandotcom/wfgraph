/**
 * Builds a probe workflow through the RPC, for a live run.
 *
 * Copy this into the scratchpad and edit the graph for whatever the question
 * is. It is here because the serialized graph format costs a session an hour to
 * rediscover: every node and edge is graphology's `{ key, attributes }` pair
 * rather than a plain object.
 *
 * The workflow it writes uses `appointments/cancel`, which is the example app's
 * own action. It does its work inside `step.run` and reaches nothing outside the
 * process, which is what makes it safe to put in a probe. An integration action
 * would send a real message.
 *
 *   node make-probe.mjs "Two waits probe"
 */

const API = "http://localhost:4017/api/rpc";

const ENTRY = "entry_1";
const START_EVENT = "app/appointment.created";
const CANCEL_EVENT = "app/appointment.canceled";

const node = (id, type, label, config) => ({
  key: id,
  attributes: {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { id, label, type, config },
  },
});

const edge = (id, source, target, sourceHandle = null) => ({
  key: id,
  source,
  target,
  attributes: { id, source, target, sourceHandle, targetHandle: null },
});

/**
 * A Wait on a clock. `require_actual_wait` stops a target already in the past
 * from falling through to a zero-length sleep, which is what a timing probe
 * needs: a wait that did not wait proves nothing.
 */
const waitNode = (id, label, duration) =>
  node(id, "action", label, {
    actionType: "Wait",
    waitMode: "delay",
    waitDuration: duration,
    waitGateMode: "require_actual_wait",
  });

/** A node that does something, addressing the entry node through a template. */
const workNode = (id, label, reason) =>
  node(id, "action", label, {
    actionType: "appointments/cancel",
    appointmentId: `{{@${ENTRY}:Probe.appointment.id}}`,
    reason,
  });

// Two sibling waits of different lengths, which is the shape that shows what one
// branch's pause costs another. The Canceled outlet is here so the same
// workflow can be used to drive a cancellation mid-wait.
const graph = {
  nodes: [
    node(ENTRY, "lifecycle", "Probe", {
      lifecycleRules: {
        concurrency: "newest-wins",
        startEvents: [START_EVENT],
        cancelEvents: [CANCEL_EVENT],
        allowManualStart: true,
      },
    }),
    waitNode("wait_short", "Wait 20s", "20s"),
    waitNode("wait_long", "Wait 90s", "90s"),
    workNode("after_short", "After short", "short branch"),
    workNode("after_long", "After long", "long branch"),
    workNode("on_cancel", "On cancel", "canceled branch"),
  ],
  edges: [
    edge("e1", ENTRY, "wait_short", "started"),
    edge("e2", ENTRY, "wait_long", "started"),
    edge("e3", "wait_short", "after_short"),
    edge("e4", "wait_long", "after_long"),
    edge("e5", ENTRY, "on_cancel", "canceled"),
  ],
};

const response = await fetch(`${API}/workflow/create`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    json: { name: process.argv[2] ?? "Live run probe", graph },
  }),
});

const body = await response.json();
if (!response.ok) {
  console.error(response.status, JSON.stringify(body));
  process.exit(1);
}

// The id every query of the run is keyed by, and the id to delete afterwards.
console.log(body.json.id);
