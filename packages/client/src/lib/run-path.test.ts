import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
import type { ExecutionLog } from "#src/lib/execution-logs";
import { runPath, runPathOutletMark } from "#src/lib/run-path";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

function node(id: string, actionType?: string): WorkflowNode {
  return {
    id,
    position: { x: 0, y: 0 },
    data:
      actionType === undefined
        ? { type: id === "start" ? "lifecycle" : "action", label: id }
        : { type: "action", label: id, config: { actionType } },
  };
}

function edge(
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return {
    id: `${source}-${sourceHandle ?? "out"}-${target}`,
    source,
    target,
    sourceHandle: sourceHandle ?? null,
  };
}

type Log = Pick<ExecutionLog, "nodeId" | "status" | "output">;

function ran(nodeId: string, output?: unknown): Log {
  return { nodeId, status: "success", output };
}

/**
 * start → check (Condition). True → remind → done. False → notify.
 */
const CONDITION_GRAPH = {
  nodes: [
    node("start"),
    node("check", BUILT_IN_ACTION_IDS.condition),
    node("remind", "send"),
    node("done", "send"),
    node("notify", "send"),
  ],
  edges: [
    edge("start", "check", "started"),
    edge("check", "remind", "true"),
    edge("remind", "done"),
    edge("check", "notify", "false"),
  ],
};

describe("runPath", () => {
  it("marks the branch a finished run's Condition answered and every other connection not taken", () => {
    const path = runPath({
      ...CONDITION_GRAPH,
      logs: [ran("start"), ran("check", { condition: false }), ran("notify")],
      executionStatus: "completed",
    });

    expect(Object.fromEntries(path.edges)).toEqual({
      "start-started-check": "taken",
      "check-true-remind": "not-taken",
      "remind-out-done": "not-taken",
      "check-false-notify": "taken",
    });
    expect(runPathOutletMark(path, "check", "false")).toBe("taken");
    expect(runPathOutletMark(path, "check", "true")).toBe("not-taken");
  });

  it("marks a branch taken before its target starts, and mutes what is below the other while the run is in progress", () => {
    const path = runPath({
      ...CONDITION_GRAPH,
      logs: [ran("start"), ran("check", { condition: true })],
      executionStatus: "running",
    });

    expect(path.edges.get("check-true-remind")).toBe("taken");
    expect(path.edges.get("check-false-notify")).toBe("not-taken");
    // `remind` has not run yet, so where it goes is undecided.
    expect(path.edges.has("remind-out-done")).toBe(false);
    expect(runPathOutletMark(path, "remind", null)).toBeNull();
  });

  it("leaves a Condition's branches undecided while its execution is unfinished", () => {
    const path = runPath({
      ...CONDITION_GRAPH,
      logs: [ran("start"), { nodeId: "check", status: "running" }],
      executionStatus: "waiting",
    });

    expect(path.edges.get("start-started-check")).toBe("taken");
    expect(path.edges.has("check-true-remind")).toBe(false);
    expect(path.edges.has("check-false-notify")).toBe(false);
    expect(runPathOutletMark(path, "check", "true")).toBeNull();
  });

  it("marks both branches taken when a Condition reached twice answered each way", () => {
    const path = runPath({
      ...CONDITION_GRAPH,
      logs: [
        ran("start"),
        ran("check", { condition: true }),
        ran("check", { condition: false }),
        ran("remind"),
        ran("done"),
        ran("notify"),
      ],
      executionStatus: "completed",
    });

    expect(path.edges.get("check-true-remind")).toBe("taken");
    expect(path.edges.get("check-false-notify")).toBe("taken");
  });

  it("keeps the other branch undecided while a second execution of a Condition is unfinished", () => {
    const path = runPath({
      ...CONDITION_GRAPH,
      logs: [
        ran("start"),
        ran("check", { condition: true }),
        { nodeId: "check", status: "running" },
      ],
      executionStatus: "running",
    });

    expect(path.edges.get("check-true-remind")).toBe("taken");
    expect(path.edges.has("check-false-notify")).toBe(false);
  });

  it("reads an answer recorded inside a step wrapper", () => {
    const path = runPath({
      ...CONDITION_GRAPH,
      logs: [
        ran("start"),
        ran("check", { success: true, data: { condition: false } }),
      ],
      executionStatus: "completed",
    });

    expect(path.edges.get("check-false-notify")).toBe("taken");
  });

  it("marks the outlet of the Event an Event Split routed by", () => {
    const booked = eventSplitOutlet("appointment.booked");
    const canceled = eventSplitOutlet("appointment.canceled");
    const path = runPath({
      nodes: [
        node("start"),
        node("split", BUILT_IN_ACTION_IDS.eventSplit),
        node("welcome", "send"),
        node("sorry", "send"),
      ],
      edges: [
        edge("start", "split", "started"),
        edge("split", "welcome", booked),
        edge("split", "sorry", canceled),
      ],
      logs: [ran("start"), ran("split", { event: "appointment.canceled" })],
      executionStatus: "running",
    });

    expect(path.edges.get(`split-${canceled}-sorry`)).toBe("taken");
    expect(path.edges.get(`split-${booked}-welcome`)).toBe("not-taken");
    expect(runPathOutletMark(path, "split", canceled)).toBe("taken");
    expect(runPathOutletMark(path, "split", booked)).toBe("not-taken");
  });

  it("marks every connection out of a failed step not taken, even while the run goes on elsewhere", () => {
    const path = runPath({
      ...CONDITION_GRAPH,
      logs: [
        ran("start"),
        ran("check", { condition: true }),
        { nodeId: "remind", status: "error" },
      ],
      executionStatus: "running",
    });

    expect(path.edges.get("remind-out-done")).toBe("not-taken");
    expect(runPathOutletMark(path, "remind", null)).toBe("not-taken");
  });

  it("marks a connection out of a successful step not taken when the finished run never reached its target", () => {
    const path = runPath({
      ...CONDITION_GRAPH,
      logs: [ran("start"), ran("check", { condition: true }), ran("remind")],
      executionStatus: "failed",
    });

    expect(path.edges.get("remind-out-done")).toBe("not-taken");
    // The path ends after a step the run finished, so its open outlet is taken.
    expect(runPathOutletMark(path, "remind", null)).toBe("taken");
  });

  it("decides nothing a run in progress has not reached yet", () => {
    const path = runPath({
      ...CONDITION_GRAPH,
      logs: [{ nodeId: "start", status: "running" }],
      executionStatus: "running",
    });

    expect(path.edges.size).toBe(0);
  });
});
