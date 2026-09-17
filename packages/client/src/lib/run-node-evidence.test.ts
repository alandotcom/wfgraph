import { describe, expect, it } from "vitest";
import type {
  ExecutionEvent,
  ExecutionLog,
  WorkflowExecution,
} from "#src/lib/execution-logs";
import {
  buildRunNodeEvidence,
  runEvidenceNodeId,
  runNodeTitle,
  shownExecution,
} from "#src/lib/run-node-evidence";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

const EXECUTION: WorkflowExecution = {
  id: "exec_1",
  workflowId: "wf_1",
  status: "completed",
  startSource: "event",
  runMode: "live",
  versionKind: "published",
  versionNumber: 3,
  startEventName: null,
  entityValue: null,
  workflowRunId: null,
  startedAt: new Date("2026-03-01T10:00:00Z"),
  waitingAt: null,
  cancelledAt: null,
  completedAt: null,
  duration: null,
  error: null,
};

function log(
  id: string,
  nodeId: string,
  startedAt: string,
  status: ExecutionLog["status"] = "success"
): ExecutionLog {
  return {
    id,
    nodeId,
    nodeName: `${nodeId} logged`,
    nodeType: "action",
    status,
    startedAt: new Date(startedAt),
    completedAt: null,
    duration: null,
    error: null,
  };
}

function node(id: string, type: string, label = id): WorkflowNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label, type: type === "group" ? "group" : "action", config: {} },
  };
}

function event(
  id: string,
  eventType: string,
  metadata: unknown,
  createdAt: string
): ExecutionEvent {
  return {
    id,
    eventType,
    message: `${eventType} message`,
    metadata,
    createdAt: new Date(createdAt),
  };
}

describe("runEvidenceNodeId", () => {
  const nodes = [node("step", "action"), node("group", "group")];

  it("names the one selected node, and no Group frame", () => {
    expect(
      runEvidenceNodeId({
        selection: { nodeIds: ["step"], edgeIds: [] },
        chosenExecution: null,
        nodes,
      })
    ).toBe("step");
    expect(
      runEvidenceNodeId({
        selection: { nodeIds: ["group"], edgeIds: [] },
        chosenExecution: null,
        nodes,
      })
    ).toBeNull();
  });

  it("names a chosen execution's node only while nothing is selected", () => {
    const chosenExecution = { nodeId: "gone", logId: "log_1" };
    expect(
      runEvidenceNodeId({
        selection: { nodeIds: [], edgeIds: [] },
        chosenExecution,
        nodes,
      })
    ).toBe("gone");
    expect(
      runEvidenceNodeId({
        selection: { nodeIds: ["step", "group"], edgeIds: [] },
        chosenExecution,
        nodes,
      })
    ).toBeNull();
  });
});

describe("shownExecution and runNodeTitle", () => {
  const logs = [
    log("first", "step", "2026-03-01T10:00:00Z", "error"),
    log("other", "other", "2026-03-01T10:00:01Z"),
    log("second", "step", "2026-03-01T10:00:02Z"),
  ];

  it("shows the chosen execution of the node, and otherwise the latest", () => {
    expect(
      shownExecution({
        logs,
        nodeId: "step",
        chosenExecution: { nodeId: "step", logId: "first" },
      })?.id
    ).toBe("first");
    expect(
      shownExecution({ logs, nodeId: "step", chosenExecution: null })?.id
    ).toBe("second");
    expect(
      shownExecution({
        logs,
        nodeId: "step",
        chosenExecution: { nodeId: "other", logId: "other" },
      })?.id
    ).toBe("second");
    expect(
      shownExecution({ logs, nodeId: "never", chosenExecution: null })
    ).toBeNull();
  });

  it("names a node by its pinned label, then its logged name", () => {
    expect(
      runNodeTitle({
        nodeId: "step",
        nodes: [node("step", "action", "Send")],
        logs,
      })
    ).toBe("Send");
    expect(runNodeTitle({ nodeId: "step", nodes: [], logs })).toBe(
      "step logged"
    );
    expect(runNodeTitle({ nodeId: "never", nodes: [], logs })).toBe("Step");
  });
});

describe("buildRunNodeEvidence", () => {
  it("orders executions, names the node's activity, and marks a removed node", () => {
    const evidence = buildRunNodeEvidence({
      nodeId: "wait",
      execution: { ...EXECUTION, status: "waiting" },
      logs: [
        log("later", "wait", "2026-03-01T10:00:05Z", "running"),
        log("earlier", "wait", "2026-03-01T10:00:00Z"),
      ],
      waits: [
        {
          id: "wait_state",
          nodeId: "wait",
          nodeName: "Wait",
          resumeToken: "tok",
          subscribedEvents: ["app/reply"],
          waitUntil: null,
        },
      ],
      events: [
        event(
          "resumed",
          "run_resumed",
          { nodeId: "wait" },
          "2026-03-01T10:00:04Z"
        ),
        event(
          "parked",
          "run_waiting",
          { nodeId: "wait" },
          "2026-03-01T10:00:01Z"
        ),
        event(
          "elsewhere",
          "run_waiting",
          { nodeId: "other" },
          "2026-03-01T10:00:02Z"
        ),
        event("started", "run_started", null, "2026-03-01T10:00:00Z"),
      ],
      nodes: [node("other", "action")],
      pinnedGraph: "ready",
      chosenExecution: null,
    });

    expect(evidence.executions.map((execution) => execution.id)).toEqual([
      "earlier",
      "later",
    ]);
    expect(evidence.shownExecution?.id).toBe("later");
    expect(evidence.activity.map((entry) => entry.id)).toEqual([
      "parked",
      "resumed",
    ]);
    expect(evidence.waits).toHaveLength(1);
    expect(evidence.removed).toBe(true);
    expect(evidence.config).toBeNull();
    expect(evidence.inProgress).toBe(true);
    expect(evidence.cancellation).toBeNull();
  });

  it("reads a canceled run's unfinished execution as cancelled, with the run's cancellation", () => {
    const evidence = buildRunNodeEvidence({
      nodeId: "step",
      execution: { ...EXECUTION, status: "canceled" },
      logs: [log("only", "step", "2026-03-01T10:00:00Z", "running")],
      waits: [
        {
          id: "wait_state",
          nodeId: "step",
          nodeName: "Step",
          resumeToken: "tok",
          subscribedEvents: [],
          waitUntil: null,
        },
      ],
      events: [event("cancel", "run_cancelled", null, "2026-03-01T10:00:03Z")],
      nodes: [node("step", "action", "Step")],
      pinnedGraph: "ready",
      chosenExecution: null,
    });

    expect(evidence.shownExecution?.status).toBe("cancelled");
    expect(evidence.cancellation?.id).toBe("cancel");
    expect(evidence.waits).toEqual([]);
    expect(evidence.removed).toBe(false);
    expect(evidence.config).toEqual({});
  });

  it("does not call a node removed while the pinned graph is not on the canvas", () => {
    const evidence = buildRunNodeEvidence({
      nodeId: "step",
      execution: EXECUTION,
      logs: [],
      waits: [],
      events: [],
      nodes: [],
      pinnedGraph: "unavailable",
      chosenExecution: null,
    });

    expect(evidence.removed).toBe(false);
    expect(evidence.shownExecution).toBeNull();
    expect(evidence.title).toBe("Step");
  });
});
