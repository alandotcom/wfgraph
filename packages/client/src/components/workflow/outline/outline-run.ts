/**
 * The outline of one run: what the run did at each step, read from the path
 * `run-path.ts` derives and the run's node statuses and logs. An exclusive
 * outlet the run did not take folds to one line naming how many steps it
 * holds, and two or more steps in a row that the run has not reached fold to
 * one line as well. Pure, so the component only reads the stores.
 */

import type { RunNodeEvidenceStatus } from "@wfgraph/shared/graph/group-run-status";
import type { OutlineRow } from "@wfgraph/shared/graph/workflow-outline";
import { unwrapStepOutput } from "@wfgraph/shared/graph/node-references";
import { isJsonObject, readJsonValue } from "@wfgraph/shared/types/json";
import {
  formatClockTimeWithSeconds,
  formatExactTime,
} from "@wfgraph/shared/utils/time";
import { type RunPath, runPathOutletMark } from "#src/lib/run-path";
import { TEST_RUN_SKIP_LABEL } from "#src/lib/test-run-skip";
import type { OutlineDisplayRow } from "./outline-view";

/** What the run did at one step, as its row shows it. */
export type RunOutcome = {
  tone: "done" | "failed" | "waiting" | "running" | "quiet";
  /**
   * "Ran", "Took True", "Woke on Payment settled", "Failed", "Waiting ·
   * resumes Nov 26, 2:00 PM", "Skipped (test run)", "Not reached".
   */
  text: string;
  /** When the step finished, or started while it is unfinished, as "9:14:02 AM". Null when it never ran. */
  time: string | null;
};

export type RunOutline = {
  rows: readonly OutlineDisplayRow[];
  /** What the run did, by row key, for step, Group and Lifecycle rows. */
  outcomes: ReadonlyMap<string, RunOutcome>;
};

type RunLog = {
  nodeId: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
  startedAt: Date;
  completedAt: Date | null;
  output?: unknown;
};

/** A Wait the run is parked on: what wakes it and when its timer ends. */
type RunWait = {
  nodeId: string;
  subscribedEvents: readonly string[];
  waitUntil: Date | null;
};

/** What a Wait's recorded output says woke it, or null when it says nothing. */
function waitWakeText(
  output: unknown,
  eventLabel: (eventName: string) => string
): string | null {
  const value = unwrapStepOutput(readJsonValue(output));
  if (!isJsonObject(value)) return null;
  if (value.timedOut === true) return "Timed out";
  return typeof value.event === "string"
    ? `Woke on ${eventLabel(value.event)}`
    : null;
}

export function runOutline(input: {
  rows: readonly OutlineRow[];
  path: RunPath;
  statuses: ReadonlyMap<string, RunNodeEvidenceStatus>;
  logs: readonly RunLog[];
  testSkipped: ReadonlySet<string>;
  /** The Waits the run is parked on now. */
  waits: readonly RunWait[];
  /** An Event's label for a sentence, by its name. */
  eventLabel: (eventName: string) => string;
  /** Whether the run has ended, so a step it did not reach never will be. */
  ended: boolean;
}): RunOutline {
  const latestLog = new Map<string, RunLog>();
  for (const log of input.logs) {
    const previous = latestLog.get(log.nodeId);
    if (!previous || previous.startedAt <= log.startedAt) {
      latestLog.set(log.nodeId, log);
    }
  }
  const outletNameByKey = new Map(
    input.rows.flatMap((row) =>
      row.kind === "outlet" ? [[row.key, row] as const] : []
    )
  );

  const outcomeOf = (row: OutlineRow): RunOutcome | null => {
    if (row.kind !== "step" && row.kind !== "lifecycle") {
      return null;
    }
    const log = latestLog.get(row.nodeId);
    const time = log
      ? formatClockTimeWithSeconds(log.completedAt ?? log.startedAt)
      : null;
    // The projection names each node it has read; a node it has not yet is
    // read from its own log.
    const status: RunNodeEvidenceStatus =
      input.statuses.get(row.nodeId) ?? log?.status ?? "none";
    if (row.kind === "lifecycle") {
      return { tone: "done", text: "Started", time: null };
    }
    if (input.testSkipped.has(row.nodeId)) {
      return { tone: "quiet", text: TEST_RUN_SKIP_LABEL, time };
    }
    switch (status) {
      case "success":
        return {
          tone: "done",
          text:
            tookText(row) ??
            (row.stepKind === "wait"
              ? (waitWakeText(log?.output, input.eventLabel) ?? "Waited")
              : "Ran"),
          time,
        };
      case "error":
        return { tone: "failed", text: "Failed", time };
      case "waiting":
        return { tone: "waiting", text: waitingText(row.nodeId), time };
      case "retrying":
        return { tone: "running", text: "Retrying", time };
      case "running":
      case "pending":
        return { tone: "running", text: "Running", time };
      case "cancelled":
        return { tone: "quiet", text: "Canceled", time };
      default:
        return {
          tone: "quiet",
          text:
            input.ended || input.path.exits.get(row.nodeId)?.final === true
              ? "Not reached"
              : "Not reached yet",
          time: null,
        };
    }
  };

  /** What a parked Wait waits for, or until when. */
  const waitingText = (nodeId: string): string => {
    const wait = input.waits.find((item) => item.nodeId === nodeId);
    if (wait?.waitUntil) {
      return `Waiting · resumes ${formatExactTime(wait.waitUntil)}`;
    }
    if (wait && wait.subscribedEvents.length > 0) {
      return `Waiting for ${wait.subscribedEvents.map(input.eventLabel).join(" or ")}`;
    }
    return "Waiting";
  };

  /** "Took True" for a Condition, the Event's name for an Event Split. */
  const tookText = (row: OutlineRow): string | null => {
    if (row.kind !== "step") return null;
    const taken = [...outletNameByKey.values()].filter(
      (outlet) =>
        outlet.sourceNodeId === row.nodeId &&
        runPathOutletMark(input.path, row.nodeId, outlet.handle) === "taken"
    );
    return taken.length > 0
      ? `Took ${taken.map((outlet) => outlet.outletName).join(" and ")}`
      : null;
  };

  const outcomes = new Map(
    input.rows.flatMap((row) => {
      const outcome = row.kind === "group" ? null : outcomeOf(row);
      return outcome ? [[row.key, outcome] as const] : [];
    })
  );
  // A Group frame records nothing of its own, so it reads as its members do.
  for (const row of input.rows) {
    if (row.kind === "group") {
      outcomes.set(
        row.key,
        groupOutcome(
          input.rows
            .filter((member) => member.parentKey === row.key)
            .flatMap((member) => outcomes.get(member.key) ?? [])
        )
      );
    }
  }
  const reached = (key: string) => {
    const outcome = outcomes.get(key);
    return outcome !== undefined && !outcome.text.startsWith("Not reached");
  };

  // Rows under an outlet the run did not take fold into that outlet's line.
  const hiddenUnder = new Set<string>();
  const rows: OutlineDisplayRow[] = [];
  const isHidden = (row: OutlineRow) =>
    row.parentKey !== null && hiddenUnder.has(row.parentKey);
  for (const row of input.rows) {
    if (isHidden(row)) {
      hiddenUnder.add(row.key);
      continue;
    }
    if (row.kind !== "outlet") {
      rows.push(row);
      continue;
    }
    const mark = outletMark(row, input, reached);
    if (mark === "taken") {
      rows.push({
        ...row,
        text: canceledOutlet(row) ? row.label : `Took ${row.outletName}`,
      });
    } else if (mark === "not-taken") {
      hiddenUnder.add(row.key);
      rows.push({ ...row, text: notTakenText(row, input.ended) });
    } else {
      rows.push(row);
    }
  }
  return {
    rows: foldNotReached({
      rows,
      outcomes,
      folded: hiddenUnder,
      ended: input.ended,
    }),
    outcomes,
  };
}

/** A Group's outcome from its members': the most pressing one, or "Ran". */
function groupOutcome(members: readonly RunOutcome[]): RunOutcome {
  for (const tone of ["failed", "waiting", "running"] as const) {
    const found = members.find((member) => member.tone === tone);
    if (found) return { ...found, time: null };
  }
  const ran = members.filter(
    (member) => !member.text.startsWith("Not reached")
  );
  if (ran.length > 0) {
    return { tone: "done", text: "Ran", time: ran.at(-1)?.time ?? null };
  }
  return members[0] ?? { tone: "quiet", text: "Not reached", time: null };
}

function canceledOutlet(row: Extract<OutlineRow, { kind: "outlet" }>) {
  return row.outletName === "Canceled" && row.depth === 0;
}

/**
 * Whether the run took an outlet. The Lifecycle Node's Canceled outlet is
 * taken once a step behind it ran, since the Lifecycle Node records no answer
 * of its own.
 */
function outletMark(
  row: Extract<OutlineRow, { kind: "outlet" }>,
  input: { rows: readonly OutlineRow[]; path: RunPath; ended: boolean },
  reached: (key: string) => boolean
): "taken" | "not-taken" | null {
  if (canceledOutlet(row)) {
    const behind = input.rows.filter(
      (candidate) => candidate.parentKey === row.key
    );
    if (behind.some((candidate) => reached(candidate.key))) return "taken";
    return "not-taken";
  }
  return runPathOutletMark(input.path, row.sourceNodeId, row.handle);
}

function notTakenText(
  row: Extract<OutlineRow, { kind: "outlet" }>,
  ended: boolean
): string {
  if (canceledOutlet(row)) {
    return `${row.label} · ${ended ? "did not happen" : "has not happened"}`;
  }
  return row.stepCount === 0
    ? `${row.label} · not taken`
    : `${row.label} · ${stepsNoun(row.stepCount)} not taken`;
}

/**
 * Two or more sibling rows in a row that the run has not reached, with all
 * the rows under them, as one line. A single such step keeps its row.
 */
function foldNotReached(input: {
  rows: readonly OutlineDisplayRow[];
  outcomes: ReadonlyMap<string, RunOutcome>;
  /** Outlets whose rows are already folded, which count their steps. */
  folded: ReadonlySet<string>;
  ended: boolean;
}): OutlineDisplayRow[] {
  const { rows, outcomes, ended } = input;
  const notReached = (row: OutlineDisplayRow) =>
    (row.kind === "step" || row.kind === "group") &&
    outcomes.get(row.key)?.text.startsWith("Not reached") === true;
  const result: OutlineDisplayRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const first = rows[index];
    if (!first || !notReached(first)) {
      if (first) result.push(first);
      index += 1;
      continue;
    }
    // The run of siblings, with every row under each of them.
    const covered: OutlineDisplayRow[] = [];
    let cursor = index;
    while (cursor < rows.length) {
      const row = rows[cursor];
      if (!row) break;
      const sibling = row.parentKey === first.parentKey;
      if (sibling && !notReached(row)) break;
      if (!sibling && !covered.some((item) => item.key === row.parentKey)) {
        break;
      }
      covered.push(row);
      cursor += 1;
    }
    const steps = covered.reduce(
      (count, row) =>
        row.kind === "step"
          ? count + 1
          : row.kind === "outlet" && input.folded.has(row.key)
            ? count + row.stepCount
            : count,
      0
    );
    if (steps < 2) {
      result.push(...covered);
    } else {
      result.push({
        kind: "note",
        key: `not-reached:${first.key}`,
        standsFor: first.key,
        depth: first.depth,
        parentKey: first.parentKey,
        text: `${steps} steps not reached${ended ? "" : " yet"}`,
      });
    }
    index = cursor;
  }
  return result;
}

function stepsNoun(count: number): string {
  return count === 1 ? "1 step" : `${count} steps`;
}
