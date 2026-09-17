import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerWorkflowRunRpc } from "#src/lib/rpc-fetch-test-support";
import {
  projectedRunStatusAtom,
  runNodeEvidenceStatusesAtom,
} from "#src/lib/workflow-graph-store";
import {
  callCount,
  execution,
  installRunsRevealRpc,
  labelledGraph,
  log,
  removeRunsRevealRpc,
  renderRunsReveal,
  runsRpc,
  served,
  waitingRun,
} from "./canvas-reveal/runs-reveal.test-support";

/** Happy-dom's viewport, which the `md` media query answers from. */
function setViewportWidth(width: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });
}

beforeEach(() => {
  setViewportWidth(1440);
  installRunsRevealRpc();
});
afterEach(() => {
  setViewportWidth(1440);
  removeRunsRevealRpc();
});

const STEPS = [
  { id: "send", label: "Send reminder" },
  { id: "w", label: "Wait for reply" },
];

describe("RunStatusProjection", () => {
  it("shows a parked Wait as Waiting from the status read alone, and as done once the wait closes", async () => {
    served.items = [execution("exec_p", "running")];
    served.graphs = { ver_exec_p: labelledGraph(STEPS) };
    served.logsByExecutionId = {
      exec_p: [
        log({ id: "l1", nodeId: "send", nodeName: "Send", status: "success" }),
        log({ id: "l2", nodeId: "w", nodeName: "Wait", status: "running" }),
      ],
    };
    served.waitsByExecutionId = { exec_p: waitingRun("exec_p", "tok_p") };
    // The logs read names no wait, so only the status read can mark `w`.
    runsRpc.override = (path, input) =>
      path === "workflow/getExecutionLogs"
        ? answerWorkflowRunRpc(
            { ...served, waitsByExecutionId: {} },
            path,
            input
          )
        : undefined;
    const { store } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_p",
    });
    const statuses = () => store.get(runNodeEvidenceStatusesAtom);

    await waitFor(() => expect(statuses().get("w")).toBe("waiting"));
    expect(statuses().get("send")).toBe("success");

    served.waitsByExecutionId = {};
    served.logsByExecutionId = {
      exec_p: [
        log({ id: "l1", nodeId: "send", nodeName: "Send", status: "success" }),
        log({ id: "l2", nodeId: "w", nodeName: "Wait", status: "success" }),
      ],
    };
    await waitFor(() => expect(statuses().get("w")).toBe("success"), {
      timeout: 2000,
    });
  });

  it("marks a newly parked Wait on a phone with no run logs read", async () => {
    // Below `md` with no sheet open, no Runs body is mounted, so the status
    // read is the only request the run's progress makes.
    setViewportWidth(390);
    served.items = [execution("exec_m", "running")];
    served.graphs = { ver_exec_m: labelledGraph(STEPS) };
    served.logsByExecutionId = {
      exec_m: [
        log({ id: "m1", nodeId: "send", nodeName: "Send", status: "running" }),
      ],
    };
    const { store, sheet } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_m",
    });
    const statuses = () => store.get(runNodeEvidenceStatusesAtom);
    await waitFor(() => expect(statuses().get("send")).toBe("running"));
    expect(sheet()).toBeNull();
    const logReads = callCount("workflow/getExecutionLogs");

    // The status read names `w` as running before its wait is recorded, and
    // the read after the wait is recorded names it as Waiting.
    served.logsByExecutionId = {
      exec_m: [
        log({ id: "m1", nodeId: "send", nodeName: "Send", status: "success" }),
        log({ id: "m2", nodeId: "w", nodeName: "Wait", status: "running" }),
      ],
    };
    await waitFor(() => expect(statuses().get("w")).toBe("running"), {
      timeout: 2000,
    });
    served.waitsByExecutionId = { exec_m: waitingRun("exec_m", "tok_m") };
    await waitFor(() => expect(statuses().get("w")).toBe("waiting"), {
      timeout: 2000,
    });
    expect(callCount("workflow/getExecutionLogs")).toBe(logReads);
  });

  it("replaces the previous run's statuses with each run's own on a run switch", async () => {
    served.items = [
      execution("exec_a", "completed"),
      execution("exec_b", "failed"),
    ];
    served.graphs = {
      ver_exec_a: labelledGraph(STEPS),
      ver_exec_b: labelledGraph(STEPS),
    };
    served.logsByExecutionId = {
      exec_a: [
        log({ id: "a1", nodeId: "send", nodeName: "Send", status: "success" }),
        log({ id: "a2", nodeId: "w", nodeName: "Wait", status: "success" }),
      ],
      exec_b: [
        log({ id: "b1", nodeId: "send", nodeName: "Send", status: "error" }),
      ],
    };
    const { store, show } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_a",
    });
    const statuses = () => store.get(runNodeEvidenceStatusesAtom);
    await waitFor(() =>
      expect([...statuses()]).toEqual([
        ["send", "success"],
        ["w", "success"],
      ])
    );

    // `w` is absent from exec_b's status read, so it keeps no status of
    // exec_a's.
    await show({ view: "runs", executionId: "exec_b" });
    await waitFor(() => expect([...statuses()]).toEqual([["send", "error"]]));
    expect(store.get(projectedRunStatusAtom)).toBe("failed");

    // exec_a's status read is cached and a completed run does not poll, so the
    // statuses the switch back projects are the only ones it gets.
    await show({ view: "runs", executionId: "exec_a" });
    await waitFor(() =>
      expect([...statuses()]).toEqual([
        ["send", "success"],
        ["w", "success"],
      ])
    );
    expect(store.get(projectedRunStatusAtom)).toBe("completed");
  });
});
