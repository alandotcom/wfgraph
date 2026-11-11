import { describe, expect, it } from "vitest";
import { createPassState } from "#src/backend/executor/runtime";

describe("createPassState", () => {
  it("names the one reported step for the heartbeat, and none while several run", () => {
    const state = createPassState();
    const slow = { stepId: "node:slow:post", nodeId: "slow" };
    const lookup = { stepId: "node:lookup:get", nodeId: "lookup" };
    const open = { stepId: "node:lookup:log-open", nodeId: "lookup" };

    state.stepStarted(slow);
    state.stepStarted(open, { reported: false });
    expect(state.heartbeatStep()).toBe(slow);

    state.stepStarted(lookup);
    expect(state.heartbeatStep()).toBeNull();
    // A budget cut still counts against the step that has run longest.
    expect(state.runningStep()).toBe(slow);

    state.stepFinished(slow);
    expect(state.heartbeatStep()).toBe(lookup);
    state.stepFinished(lookup);
    state.stepFinished(open);
    expect(state.heartbeatStep()).toBeNull();
  });
});
