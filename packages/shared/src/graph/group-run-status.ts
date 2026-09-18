/**
 * A Group's status in one run, derived from the evidence of its real members and
 * the Group boundary. A Group records nothing of its own in a run, so every
 * answer here is read off member evidence, the evidence of the steps the Group
 * continues to, and the run's own status.
 */

import { countBy } from "es-toolkit/array";
import {
  analyzeGroupBoundaryById,
  type GroupBoundaryEdge,
} from "#src/graph/group-boundary";
import type { WorkflowExecutionStatus } from "#src/lifecycle/execution-contracts";

/**
 * What a run recorded for one real node, from its latest execution. `none` is a
 * node the run has not reached. `waiting` is an unfinished execution the run is
 * parked on. `pending` is a reached node with no further proof of progress.
 */
export type RunNodeEvidenceStatus =
  | "none"
  | "pending"
  | "running"
  | "waiting"
  | "success"
  | "error"
  | "cancelled";

export type GroupRunStatus =
  | "idle"
  | "reached"
  | "running"
  | "waiting"
  | "canceled"
  | "failed"
  | "successful";

export type GroupRunSummary = {
  status: GroupRunStatus;
  /** Each member with its evidence status, in graph order. */
  members: ReadonlyArray<{ nodeId: string; status: RunNodeEvidenceStatus }>;
  stepCount: number;
  /** Members with any recorded evidence. */
  reachedCount: number;
  failedCount: number;
  canceledCount: number;
  waitingCount: number;
  runningCount: number;
};

/**
 * The run status of the Group `groupId`. Any failed member makes it Failed, then
 * Canceled, Waiting and Running in that order. With no member reached it is
 * Idle. A Group is Successful once a step it continues to has evidence, or once
 * the run completed with evidence at a member where a path ends inside the
 * Group. A Group with no continuation edge is also Successful once the run
 * completed. Every other reached Group is Reached.
 */
export function summarizeGroupRun(input: {
  groupId: string;
  nodes: readonly { id: string; parentId?: string | undefined }[];
  edges: readonly GroupBoundaryEdge[];
  /** Evidence by real node id; a node that is not listed has none. */
  evidence: ReadonlyMap<string, RunNodeEvidenceStatus>;
  executionStatus: WorkflowExecutionStatus;
}): GroupRunSummary {
  const boundary = analyzeGroupBoundaryById(input);
  const statusOf = (nodeId: string): RunNodeEvidenceStatus =>
    input.evidence.get(nodeId) ?? "none";
  const members = boundary.memberIds.map((nodeId) => ({
    nodeId,
    status: statusOf(nodeId),
  }));
  const counts = countBy(members, (member) => member.status);
  const summary: Omit<GroupRunSummary, "status"> = {
    members,
    stepCount: members.length,
    reachedCount: members.length - (counts.none ?? 0),
    failedCount: counts.error ?? 0,
    canceledCount: counts.cancelled ?? 0,
    waitingCount: counts.waiting ?? 0,
    runningCount: counts.running ?? 0,
  };
  const hasEvidence = (nodeId: string) => statusOf(nodeId) !== "none";
  const completed = input.executionStatus === "completed";
  const completionProven =
    boundary.externalTargets.some((port) => hasEvidence(port.nodeId)) ||
    (completed &&
      (boundary.continuationEdges.length === 0 ||
        boundary.terminalMemberIds.some(hasEvidence)));
  return { ...summary, status: groupStatus(summary, completionProven) };
}

/** The precedence `summarizeGroupRun` states, over counted member evidence. */
function groupStatus(
  summary: Omit<GroupRunSummary, "status">,
  completionProven: boolean
): GroupRunStatus {
  if (summary.failedCount > 0) {
    return "failed";
  }
  if (summary.canceledCount > 0) {
    return "canceled";
  }
  if (summary.waitingCount > 0) {
    return "waiting";
  }
  if (summary.runningCount > 0) {
    return "running";
  }
  if (summary.reachedCount === 0) {
    return "idle";
  }
  return completionProven ? "successful" : "reached";
}

const GROUP_RUN_STATUS_LABELS = {
  idle: "Idle",
  reached: "Reached",
  running: "Running",
  waiting: "Waiting",
  canceled: "Canceled",
  failed: "Failed",
  successful: "Successful",
} satisfies Record<GroupRunStatus, string>;

/** How a Group run status reads on screen. */
export function groupRunStatusLabel(status: GroupRunStatus): string {
  return GROUP_RUN_STATUS_LABELS[status];
}

/**
 * The summary's member counts as one sentence fragment, such as "3 of 5 steps
 * reached, 1 failed". Only counts above zero follow the reached count.
 */
export function groupRunCountsText(summary: GroupRunSummary): string {
  const steps = summary.stepCount === 1 ? "step" : "steps";
  const details = [
    [summary.failedCount, "failed"],
    [summary.canceledCount, "canceled"],
    [summary.waitingCount, "waiting"],
    [summary.runningCount, "running"],
  ] as const;
  return [
    `${summary.reachedCount} of ${summary.stepCount} ${steps} reached`,
    ...details
      .filter(([count]) => count > 0)
      .map(([count, word]) => `${count} ${word}`),
  ].join(", ");
}
