import { describe, expect, it } from "vitest";
import {
  groupRunCountsText,
  groupRunStatusLabel,
  type RunNodeEvidenceStatus,
  summarizeGroupRun,
} from "#src/graph/group-run-status";
import type { WorkflowExecutionStatus } from "#src/lifecycle/execution-contracts";

type Edge = { source: string; target: string; sourceHandle?: string };

/**
 * life -> a -> b -> c -> after, with a, b and c in Group g. `terminal` drops the
 * edge from c to after, so the path ends inside the Group.
 */
function chain(options: { terminal?: boolean } = {}) {
  const nodes = [
    { id: "life" },
    { id: "g" },
    { id: "a", parentId: "g" },
    { id: "b", parentId: "g" },
    { id: "c", parentId: "g" },
    { id: "after" },
  ];
  const edges: Edge[] = [
    { source: "life", target: "a", sourceHandle: "started" },
    { source: "a", target: "b" },
    { source: "b", target: "c" },
    ...(options.terminal ? [] : [{ source: "c", target: "after" }]),
  ];
  return { nodes, edges };
}

function summarize(input: {
  graph: ReturnType<typeof chain>;
  evidence: Record<string, RunNodeEvidenceStatus>;
  executionStatus: WorkflowExecutionStatus;
}) {
  return summarizeGroupRun({
    groupId: "g",
    ...input.graph,
    evidence: new Map(Object.entries(input.evidence)),
    executionStatus: input.executionStatus,
  });
}

describe("summarizeGroupRun", () => {
  it("is Idle when no member has evidence, even once the run completed", () => {
    const summary = summarize({
      graph: chain({ terminal: true }),
      evidence: { life: "success" },
      executionStatus: "completed",
    });
    expect(summary.status).toBe("idle");
    expect(summary.reachedCount).toBe(0);
    expect(groupRunCountsText(summary)).toBe("0 of 3 steps reached");
  });

  it("is Successful for a continuing Group only once the step after it has evidence", () => {
    const graph = chain();
    const inside = { a: "success", b: "success", c: "success" } as const;
    expect(
      summarize({ graph, evidence: inside, executionStatus: "running" }).status
    ).toBe("reached");
    expect(
      summarize({
        graph,
        evidence: { ...inside, after: "pending" },
        executionStatus: "running",
      }).status
    ).toBe("successful");
  });

  it("stays Reached when a continuing Group's run stopped short of any ending, even after the run completed", () => {
    const summary = summarize({
      graph: chain(),
      evidence: { a: "success", b: "success" },
      executionStatus: "completed",
    });
    expect(summary.status).toBe("reached");
    expect(groupRunCountsText(summary)).toBe("2 of 3 steps reached");
  });

  it("is Successful for a continuing Group once the run completed along a path that ends inside it", () => {
    // a -> b -> after continues out of the Group, and a -> c ends inside it.
    const graph = {
      nodes: chain().nodes,
      edges: [
        { source: "life", target: "a", sourceHandle: "started" },
        { source: "a", target: "b" },
        { source: "a", target: "c" },
        { source: "b", target: "after" },
      ],
    };
    const evidence = { a: "success", c: "success" } as const;
    expect(
      summarize({ graph, evidence, executionStatus: "running" }).status
    ).toBe("reached");
    expect(
      summarize({ graph, evidence, executionStatus: "completed" }).status
    ).toBe("successful");
  });

  it("is Successful when a Condition inside the Group takes the branch that ends inside it and the run completed", () => {
    // Condition a sends True to b, which continues to after, and False to c,
    // which ends inside the Group.
    const graph = {
      nodes: chain().nodes,
      edges: [
        { source: "life", target: "a", sourceHandle: "started" },
        { source: "a", target: "b", sourceHandle: "true" },
        { source: "a", target: "c", sourceHandle: "false" },
        { source: "b", target: "after" },
      ],
    };
    const falseBranch = summarize({
      graph,
      evidence: { a: "success", c: "success" },
      executionStatus: "completed",
    });
    expect(falseBranch.status).toBe("successful");
    expect(groupRunCountsText(falseBranch)).toBe("2 of 3 steps reached");

    const trueBranch = summarize({
      graph,
      evidence: { a: "success", b: "success", after: "success" },
      executionStatus: "completed",
    });
    expect(trueBranch.status).toBe("successful");
  });

  it("is Successful once either of two steps the Group's exit leads to has evidence", () => {
    const graph = {
      nodes: [...chain().nodes, { id: "other" }],
      edges: [...chain().edges, { source: "c", target: "other" }],
    };
    const inside = { a: "success", b: "success", c: "success" } as const;
    expect(
      summarize({ graph, evidence: inside, executionStatus: "running" }).status
    ).toBe("reached");
    for (const target of ["after", "other"]) {
      expect(
        summarize({
          graph,
          evidence: { ...inside, [target]: "pending" },
          executionStatus: "running",
        }).status
      ).toBe("successful");
    }
  });

  it("is Successful for a terminal Group only when the whole run completed", () => {
    const graph = chain({ terminal: true });
    const evidence = { a: "success", b: "success", c: "success" } as const;
    expect(
      summarize({ graph, evidence, executionStatus: "completed" }).status
    ).toBe("successful");
    for (const executionStatus of [
      "running",
      "exited",
      "superseded",
    ] as const) {
      expect(summarize({ graph, evidence, executionStatus }).status).toBe(
        "reached"
      );
    }
  });

  it("reports a partial branch without completion proof as Reached", () => {
    const summary = summarize({
      graph: chain({ terminal: true }),
      evidence: { a: "success", b: "pending" },
      executionStatus: "running",
    });
    expect(summary.status).toBe("reached");
    expect(summary.members).toEqual([
      { nodeId: "a", status: "success" },
      { nodeId: "b", status: "pending" },
      { nodeId: "c", status: "none" },
    ]);
  });

  it("orders Failed, Canceled, Waiting, Running, Reached", () => {
    const graph = chain();
    const statusFor = (evidence: Record<string, RunNodeEvidenceStatus>) =>
      summarize({ graph, evidence, executionStatus: "running" }).status;

    expect(
      statusFor({
        a: "error",
        b: "cancelled",
        c: "waiting",
        after: "success",
      })
    ).toBe("failed");
    expect(statusFor({ a: "cancelled", b: "waiting", c: "running" })).toBe(
      "canceled"
    );
    expect(statusFor({ a: "success", b: "waiting", c: "running" })).toBe(
      "waiting"
    );
    expect(statusFor({ a: "success", b: "running" })).toBe("running");
    expect(statusFor({ a: "success", b: "pending" })).toBe("reached");
  });

  it("is Failed when any reached member failed, whatever follows the Group", () => {
    const summary = summarize({
      graph: chain(),
      evidence: { a: "success", b: "error", after: "success" },
      executionStatus: "completed",
    });
    expect(summary.status).toBe("failed");
    expect(groupRunCountsText(summary)).toBe("2 of 3 steps reached, 1 failed");
  });

  it("counts waits and cancellation as facts about members", () => {
    const waiting = summarize({
      graph: chain(),
      evidence: { a: "success", b: "waiting" },
      executionStatus: "waiting",
    });
    expect(waiting.status).toBe("waiting");
    expect(groupRunCountsText(waiting)).toBe("2 of 3 steps reached, 1 waiting");

    const canceled = summarize({
      graph: chain(),
      evidence: { a: "success", b: "cancelled" },
      executionStatus: "canceled",
    });
    expect(canceled.status).toBe("canceled");
    expect(groupRunCountsText(canceled)).toBe(
      "2 of 3 steps reached, 1 canceled"
    );
  });

  it("ignores evidence recorded for the Group frame id", () => {
    const summary = summarize({
      graph: chain({ terminal: true }),
      evidence: { g: "success" },
      executionStatus: "completed",
    });
    expect(summary.status).toBe("idle");
    expect(summary.members.map((member) => member.nodeId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("reads each status and a single step in plain words", () => {
    expect(groupRunStatusLabel("successful")).toBe("Successful");
    expect(groupRunStatusLabel("canceled")).toBe("Canceled");
    expect(
      groupRunCountsText({
        status: "running",
        members: [{ nodeId: "a", status: "running" }],
        stepCount: 1,
        reachedCount: 1,
        failedCount: 0,
        canceledCount: 0,
        waitingCount: 0,
        runningCount: 1,
      })
    ).toBe("1 of 1 step reached, 1 running");
  });
});
