import { describe, expect, it } from "vitest";
import {
  outlineRows,
  workflowOutline,
} from "@wfgraph/shared/graph/workflow-outline";
import {
  heroGraph,
  outlineTestCatalog,
} from "@wfgraph/shared/graph/workflow-outline-test-support";
import type { RunNodeEvidenceStatus } from "@wfgraph/shared/graph/group-run-status";
import { runPath } from "#src/lib/run-path";
import { toEditorEdge, toEditorNode } from "#src/lib/workflow-graph-types";
import { runOutline } from "./outline-run";

function log(nodeId: string, output?: unknown) {
  return {
    nodeId,
    status: "success" as const,
    output,
    startedAt: new Date(2026, 10, 25, 9, 0, 0),
    completedAt: new Date(2026, 10, 25, 9, 0, 1),
  };
}

/** The seeded workflow's outline as one ended run read it. */
function endedRun(input: {
  logs: ReturnType<typeof log>[];
  testSkipped?: ReadonlySet<string>;
  waits?: {
    nodeId: string;
    subscribedEvents: string[];
    waitUntil: Date | null;
  }[];
  statuses?: ReadonlyMap<string, RunNodeEvidenceStatus>;
}) {
  const graph = heroGraph();
  const rows = outlineRows(
    workflowOutline({ ...graph, catalog: outlineTestCatalog })
  );
  return runOutline({
    rows,
    path: runPath({
      nodes: graph.nodes.map((node) => toEditorNode(node)),
      edges: graph.edges.map((edge) => toEditorEdge(edge)),
      logs: input.logs,
      executionStatus: "canceled",
    }),
    statuses:
      input.statuses ??
      new Map(input.logs.map((entry) => [entry.nodeId, "success"])),
    logs: input.logs,
    testSkipped: input.testSkipped ?? new Set(),
    waits: input.waits ?? [],
    eventLabel: (name) => `event ${name}`,
    ended: true,
  });
}

function texts(result: ReturnType<typeof runOutline>): string[] {
  return result.rows.flatMap((row) =>
    row.kind === "outlet" || row.kind === "note" ? [row.text] : []
  );
}

describe("runOutline", () => {
  it("shows the Canceled branch a run took, and folds the Started steps it never reached", () => {
    const result = endedRun({
      logs: [
        log("Enough time for reminders?", { condition: true }),
        log("Send cancellation notice"),
      ],
    });

    expect(texts(result)).toContain("Appointment canceled");
    expect(result.outcomes.get("Send cancellation notice")?.text).toBe("Ran");
    expect(texts(result)).toContain("14 steps not reached");
  });

  it("says a Cancel Event did not happen in a run that ended without one", () => {
    const result = endedRun({
      logs: [log("Enough time for reminders?", { condition: false })],
    });

    expect(texts(result)).toContain("Appointment canceled · did not happen");
    expect(texts(result)).toContain("If true · 14 steps not taken");
    expect(result.outcomes.get("Enough time for reminders?")?.text).toBe(
      "Took False"
    );
  });

  it("names a step a test run skipped in the canvas chip's words", () => {
    const result = endedRun({
      logs: [
        log("Enough time for reminders?", { condition: true }),
        log("Send booking confirmation"),
      ],
      testSkipped: new Set(["Send booking confirmation"]),
    });

    expect(result.outcomes.get("Send booking confirmation")?.text).toBe(
      "Skipped (test run)"
    );
  });

  it("says what woke a Wait, and when a parked Wait resumes", () => {
    const woke = endedRun({
      logs: [
        log("Enough time for reminders?", { condition: true }),
        log("Send booking confirmation"),
        log("Wait for deposit or reschedule", {
          timedOut: false,
          event: "billing/payment.settled",
        }),
      ],
    });
    expect(woke.outcomes.get("Wait for deposit or reschedule")?.text).toBe(
      "Woke on event billing/payment.settled"
    );

    const resumesAt = new Date(2026, 10, 30, 14, 0, 0);
    const parked = endedRun({
      logs: [log("Wait until 24 hours before")],
      statuses: new Map([["Wait until 24 hours before", "waiting"]]),
      waits: [
        {
          nodeId: "Wait until 24 hours before",
          subscribedEvents: [],
          waitUntil: resumesAt,
        },
      ],
    });
    const outcome = parked.outcomes.get("Wait until 24 hours before");
    expect(outcome?.tone).toBe("waiting");
    expect(outcome?.text).toMatch(/^Waiting · resumes /u);
  });
});
