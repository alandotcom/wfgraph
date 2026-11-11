/**
 * The Arriving Event cases: each branch carries the Event that put it where
 * it is, so two event-mode Waits on parallel branches hand the nodes below
 * each its own Event and payload, whichever Wait a pass replays last.
 */

import { Effect } from "effect";
import { expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
import {
  type JsonObject,
  readJsonObjectLeniently,
} from "@wfgraph/shared/types/json";
import type { WorkflowActions } from "#src/backend/engine/actions";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { executeTestWorkflow } from "#src/backend/engine/test-execution";
import {
  driveWithReplay,
  type ReplayExecutor,
  type ReplayRunOptions,
} from "#src/backend/engine/testing/replay-runtime";
import {
  createLifecycleNode,
  createWaitNode,
  resumeWake,
} from "#src/backend/engine/testing/wait-fixtures";

const CREATED = "app/order.created";
const SETTLED = "billing/payment.settled";
const REFUNDED = "billing/refund.requested";
const AMOUNT_TOKEN = "{{@lifecycle_1:Lifecycle.amount}}";

/** An action node whose `amount` field reads the entry node's `amount`. */
function amountNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: "action",
      config: { actionType: "test/send", amount: AMOUNT_TOKEN },
    },
  };
}

function node(
  id: string,
  config: Record<string, unknown>,
  label = id
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label, type: "action", config },
  };
}

function edge(source: string, target: string, sourceHandle?: string) {
  const base: WorkflowEdge = { id: `${source}-${target}`, source, target };
  return sourceHandle === undefined ? base : { ...base, sourceHandle };
}

/**
 * An action whose work, inside `step.run`, records the `amount` it resolved
 * for each node, so a replay answers it from the memo and records nothing.
 */
function amountRecordingActions(
  amounts: Map<string, unknown>
): WorkflowActions {
  return {
    stepFor: () => (input, steps) =>
      Effect.promise(async () => {
        const nodeId = readJsonObjectLeniently(input._context)?.nodeId;
        const key = typeof nodeId === "string" ? nodeId : "";
        const record = () => {
          amounts.set(key, input.amount);
          return Promise.resolve({ sent: true });
        };
        const data = steps ? await steps.run("send", record) : await record();
        return { success: true as const, data };
      }),
    metadataFor: () => ({
      label: "Send",
      literalConfigKeys: [],
      templateJsonConfigShapes: [],
    }),
    catalogFingerprint: () => "catalog",
  };
}

function drive(input: {
  executor: ReplayExecutor;
  graph: ReturnType<typeof createSerializedWorkflowGraph>;
  startPayload: JsonObject;
  events: ReplayRunOptions["events"];
}) {
  const store = createRecordingWorkflowStore();
  const amounts = new Map<string, unknown>();
  const run = driveWithReplay(
    (runtime) =>
      executeTestWorkflow(
        {
          graph: input.graph,
          executionId: "exec_arrival",
          workflowId: "workflow_arrival",
          startEventName: CREATED,
          startPayload: input.startPayload,
        },
        runtime,
        store,
        amountRecordingActions(amounts)
      ),
    { events: input.events, executor: input.executor, waitRows: store }
  );
  return { run, amounts };
}

export function defineArrivingEventReplayCases(executor: ReplayExecutor): void {
  // W1 is woken by the settlement at one hour and W2 times out at two. The
  // pass that resumes W3 a day later replays both, and the Email and the
  // Event Split below W3 read W1's arrival however that pass ordered them.
  // The node below W2 reads no Event, since its Wait timed out and continued.
  it("hands each branch the arrival of the nearest Wait above it", async () => {
    const { run, amounts } = drive({
      executor,
      startPayload: { amount: "start" },
      graph: createSerializedWorkflowGraph({
        nodes: [
          createLifecycleNode("lifecycle_1"),
          createWaitNode("w1", {
            waitMode: "event",
            waitFor: [{ event: SETTLED }],
            waitTimeout: "1h",
          }),
          createWaitNode("w2", {
            waitMode: "event",
            waitFor: [{ event: REFUNDED }],
            waitTimeout: "2h",
            waitTimeoutBehavior: "continue",
          }),
          createWaitNode("w3", { waitMode: "delay", waitDuration: "1d" }),
          amountNode("email"),
          node(
            "split",
            { actionType: BUILT_IN_ACTION_IDS.eventSplit },
            "Split"
          ),
          node("on_settled", { actionType: "Condition", condition: true }),
          amountNode("refund_check"),
        ],
        edges: [
          edge("lifecycle_1", "w1", "started"),
          edge("lifecycle_1", "w2", "started"),
          edge("w1", "w3"),
          edge("w3", "email"),
          edge("w3", "split"),
          edge("split", "on_settled", eventSplitOutlet(SETTLED)),
          edge("w2", "refund_check"),
        ],
      }),
      events: { "wait-park-w1-0": resumeWake({ amount: "42" }, SETTLED) },
    });

    const { value } = await run;
    expect(value.status).toBe("completed");
    expect(amounts.get("email")).toBe("42");
    expect(value.results.on_settled?.success).toBe(true);
    expect(amounts.get("refund_check")).toBe("");
  });

  // Two event Waits on parallel branches, each woken by its own Event:
  // `wait_b` at one hour, `wait_a` at two. The pass that ends `delay_b` a day
  // later replays both Waits, entering `wait_b` first because its edge is
  // listed first, and `email_b` below the delay still reads `wait_b`'s Event.
  it("keeps two event Waits' arrivals apart on their own branches", async () => {
    const { run, amounts } = drive({
      executor,
      startPayload: { amount: "start" },
      graph: createSerializedWorkflowGraph({
        nodes: [
          createLifecycleNode("lifecycle_1"),
          createWaitNode("wait_a", {
            waitMode: "event",
            waitFor: [{ event: SETTLED }],
            waitTimeout: "2h",
          }),
          createWaitNode("wait_b", {
            waitMode: "event",
            waitFor: [{ event: REFUNDED }],
            waitTimeout: "1h",
          }),
          createWaitNode("delay_b", { waitMode: "delay", waitDuration: "1d" }),
          amountNode("email_a"),
          amountNode("email_b"),
        ],
        edges: [
          edge("lifecycle_1", "wait_b", "started"),
          edge("lifecycle_1", "wait_a", "started"),
          edge("wait_a", "email_a"),
          edge("wait_b", "delay_b"),
          edge("delay_b", "email_b"),
        ],
      }),
      events: {
        "wait-park-wait_a-0": resumeWake({ amount: "A" }, SETTLED),
        "wait-park-wait_b-0": resumeWake({ amount: "B" }, REFUNDED),
      },
    });

    const { value } = await run;
    expect(value.status).toBe("completed");
    expect(amounts.get("email_a")).toBe("A");
    expect(amounts.get("email_b")).toBe("B");
  });
}
