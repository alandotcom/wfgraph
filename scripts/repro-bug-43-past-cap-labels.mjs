/**
 * One-shot repro for GitHub #43: deep-linked past-cap runs lose identity.
 *
 * Mirrors `toWorkflowExecutionFromSummary` hardcoding (execution-logs.ts:164-183).
 * Run: node scripts/repro-bug-43-past-cap-labels.mjs
 */
import { appendFileSync, mkdirSync } from "node:fs";

/** Same hardcoding as packages/client/src/lib/execution-logs.ts */
function toWorkflowExecutionFromSummary(summary) {
  return {
    id: summary.id,
    workflowId: summary.workflowId,
    status: summary.status,
    startSource: null,
    runMode: "live",
    startEventName: null,
    entityValue: null,
    workflowRunId: null,
    startedAt: new Date(summary.startedAt),
    waitingAt: null,
    cancelledAt: null,
    completedAt: summary.completedAt ? new Date(summary.completedAt) : null,
    duration: summary.duration,
    error: summary.error,
  };
}

const summaryThatShouldBeTestEvent = {
  id: "exec_past_cap",
  workflowId: "wf_1",
  status: "completed",
  startedAt: "2026-03-01T10:00:00.000Z",
  completedAt: "2026-03-01T10:00:30.000Z",
  duration: "30s",
  error: null,
  // Fields the row should carry (omitted by executionSummarySchema / mapper today)
  runMode: "test",
  startSource: "event",
  startEventName: "app/appointment.created",
  entityValue: "appt_99",
};

const listedIndex = -1; // past newest-50 cap → not in polled list
const executionsLength = 1;
const runNumber = listedIndex >= 0 ? executionsLength - listedIndex : 0;

const mapped = toWorkflowExecutionFromSummary(summaryThatShouldBeTestEvent);

const evidence = {
  location: "scripts/repro-bug-43-past-cap-labels.mjs",
  message: "BUG #43 mapper + runNumber hardcoding",
  hypothesisId: "A+C",
  data: {
    summaryRunMode: summaryThatShouldBeTestEvent.runMode,
    summaryStartSource: summaryThatShouldBeTestEvent.startSource,
    mappedRunMode: mapped.runMode,
    mappedStartSource: mapped.startSource,
    mappedStartEventName: mapped.startEventName,
    mappedEntityValue: mapped.entityValue,
    runNumber,
    wouldShowTestModeBadge: mapped.runMode === "test",
    wouldShowRun0: runNumber === 0,
  },
  timestamp: Date.now(),
};

mkdirSync("/opt/cursor/logs", { recursive: true });
appendFileSync("/opt/cursor/logs/debug.log", `${JSON.stringify(evidence)}\n`);
console.log(JSON.stringify(evidence, null, 2));

const mapperBroken =
  mapped.runMode === "live" &&
  mapped.startSource === null &&
  summaryThatShouldBeTestEvent.runMode === "test";
const uiBroken = runNumber === 0 && mapped.runMode !== "test";

if (mapperBroken && uiBroken) {
  console.error(
    "\nREPRODUCED BUG #43: mapper yields live/null identity; past-cap runNumber is 0 (no Test Mode badge)."
  );
  process.exit(1);
}

console.error("Unexpected: bug conditions not met");
process.exit(2);
