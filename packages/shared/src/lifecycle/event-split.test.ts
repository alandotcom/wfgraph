import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import {
  eventSplitOutlet,
  eventSplitOutletEvent,
  isEventSplitNode,
} from "#src/lifecycle/event-split";
import type { WorkflowNode } from "#src/graph/types";

function aNode(config: Record<string, unknown>): WorkflowNode {
  return {
    id: "node-1",
    type: "action",
    position: { x: 0, y: 0 },
    data: { type: "action", label: "Split", config },
  };
}

describe("event-split", () => {
  it("reads back the Event an outlet names", () => {
    const handle = eventSplitOutlet("app/appointment.created");

    expect(eventSplitOutletEvent(handle)).toBe("app/appointment.created");
  });

  it("keeps an Event name that reads like another handle apart from it", () => {
    // Nothing stops an app declaring an Event called `true`, and the graph save
    // reads a Condition's branch off the same field.
    expect(eventSplitOutletEvent(eventSplitOutlet("true"))).toBe("true");
    expect(eventSplitOutletEvent("true")).toBeNull();
    expect(eventSplitOutletEvent("started")).toBeNull();
  });

  it("answers nothing for a handle that names no Event", () => {
    expect(eventSplitOutletEvent(undefined)).toBeNull();
    expect(eventSplitOutletEvent(null)).toBeNull();
    expect(eventSplitOutletEvent("event:")).toBeNull();
    expect(eventSplitOutletEvent("event:   ")).toBeNull();
  });

  it("recognises the node by its action type", () => {
    expect(
      isEventSplitNode(aNode({ actionType: BUILT_IN_ACTION_IDS.eventSplit }))
    ).toBe(true);
    expect(isEventSplitNode(aNode({ actionType: "Condition" }))).toBe(false);
    expect(isEventSplitNode(undefined)).toBe(false);
  });
});
