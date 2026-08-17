import { describe, expect, it } from "vitest";
import { andJoinRefusalReason } from "#src/graph/and-join";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import { eventSplitOutlet } from "#src/lifecycle/event-split";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "#src/lifecycle/lifecycle-outlets";

function lifecycle(id = "lifecycle_1"): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "Lifecycle", type: "lifecycle", config: {} },
  };
}

function action(id: string, actionType = "custom/lookup"): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: "action",
      config: { actionType },
    },
  };
}

function wait(id: string): WorkflowNode {
  return action(id, "Wait");
}

function condition(id: string): WorkflowNode {
  return action(id, "Condition");
}

function eventSplit(id: string): WorkflowNode {
  return action(id, "Event Split");
}

function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return { id, source, target, ...(sourceHandle ? { sourceHandle } : {}) };
}

describe("andJoinRefusalReason", () => {
  it("allows a diamond of two actions behind Started", () => {
    expect(
      andJoinRefusalReason({
        nodes: [lifecycle(), action("left"), action("right"), action("join")],
        edges: [
          edge("e1", "lifecycle_1", "left", LIFECYCLE_STARTED_HANDLE),
          edge("e2", "lifecycle_1", "right", LIFECYCLE_STARTED_HANDLE),
          edge("e3", "left", "join"),
          edge("e4", "right", "join"),
        ],
      })
    ).toBeNull();
  });

  it("refuses Started↔Canceled rejoins", () => {
    expect(
      andJoinRefusalReason({
        nodes: [lifecycle(), action("started"), action("canceled")],
        edges: [
          edge("e1", "lifecycle_1", "started", LIFECYCLE_STARTED_HANDLE),
          edge("e2", "lifecycle_1", "canceled", LIFECYCLE_CANCELED_HANDLE),
          edge("e3", "canceled", "started"),
        ],
      })
    ).toContain("cannot join the Started and Canceled branches");
  });

  it("refuses a Wait on either arm", () => {
    expect(
      andJoinRefusalReason({
        nodes: [lifecycle(), action("left"), wait("wait_1"), action("join")],
        edges: [
          edge("e1", "lifecycle_1", "left", LIFECYCLE_STARTED_HANDLE),
          edge("e2", "lifecycle_1", "wait_1", LIFECYCLE_STARTED_HANDLE),
          edge("e3", "left", "join"),
          edge("e4", "wait_1", "join"),
        ],
      })
    ).toContain("cannot join branches that include a Wait");
  });

  it("allows a Wait above the fan-out", () => {
    expect(
      andJoinRefusalReason({
        nodes: [
          lifecycle(),
          wait("wait_1"),
          action("left"),
          action("right"),
          action("join"),
        ],
        edges: [
          edge("e1", "lifecycle_1", "wait_1", LIFECYCLE_STARTED_HANDLE),
          edge("e2", "wait_1", "left"),
          edge("e3", "wait_1", "right"),
          edge("e4", "left", "join"),
          edge("e5", "right", "join"),
        ],
      })
    ).toBeNull();
  });

  it("refuses joining Condition true/false arms", () => {
    expect(
      andJoinRefusalReason({
        nodes: [
          lifecycle(),
          condition("cond"),
          action("t"),
          action("f"),
          action("join"),
        ],
        edges: [
          edge("e1", "lifecycle_1", "cond", LIFECYCLE_STARTED_HANDLE),
          edge("e2", "cond", "t", "true"),
          edge("e3", "cond", "f", "false"),
          edge("e4", "t", "join"),
          edge("e5", "f", "join"),
        ],
      })
    ).toContain("cannot join mutually exclusive branches");
  });

  it("refuses joining Event Split outlets", () => {
    expect(
      andJoinRefusalReason({
        nodes: [
          lifecycle(),
          eventSplit("split"),
          action("a"),
          action("b"),
          action("join"),
        ],
        edges: [
          edge("e1", "lifecycle_1", "split", LIFECYCLE_STARTED_HANDLE),
          edge("e2", "split", "a", eventSplitOutlet("app/a")),
          edge("e3", "split", "b", eventSplitOutlet("app/b")),
          edge("e4", "a", "join"),
          edge("e5", "b", "join"),
        ],
      })
    ).toContain("cannot join mutually exclusive branches");
  });
});
