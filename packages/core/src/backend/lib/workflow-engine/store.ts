/**
 * Persistence port for the workflow engine.
 *
 * The engine records what a run did - step logs, timeline events, wait states,
 * the terminal run row - but it must not know how any of that is stored. Every
 * write goes through this interface, so the engine module itself never imports
 * the database layer. Which adapter is handed in decides whether a run persists
 * at all: the Postgres-backed adapter for real runs, `noopWorkflowStore` for
 * runs that should leave no trace, a recording adapter in tests.
 *
 * Sibling port: `WorkflowExecutionRuntime` in ./runtime covers durability (step
 * memoization, sleeping, waiting for events). Keep the two apart - nothing in
 * here may know about replay, and nothing there may know about wait-state rows.
 *
 * Every value crossing this interface is JSON-safe (timestamps travel as ISO
 * strings) because store calls happen inside memoized steps whose results
 * round-trip through the durable runtime's storage.
 */

import type { JsonObject } from "@rova/shared/types/json";

/**
 * Timeline events the engine itself emits. The database accepts a wider set;
 * this union is deliberately limited to what the executor writes so the port
 * stays as narrow as its call sites.
 */
export type WorkflowRunAuditEventType =
  | "run_waiting"
  | "run_skipped"
  | "run_resumed"
  | "run_timed_out"
  | "run_cancelled"
  | "run_completed"
  | "run_failed";

/**
 * Identifies an open step-log row. Handed back by `startStepLog` and passed to
 * `completeStepLog` to close the same row, so it survives a replay unchanged.
 */
export type WorkflowStepLogHandle = {
  logId: string;
  startTime: number;
};

export type StartStepLogInput = {
  executionId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  input?: unknown;
};

export type CompleteStepLogInput = {
  logId: string;
  startTime: number;
  status: "success" | "error";
  output?: unknown;
  error?: string;
};

export type RecordAuditEventInput = {
  workflowId: string;
  executionId: string;
  eventType: WorkflowRunAuditEventType;
  message: string;
  metadata?: Record<string, unknown>;
};

export type CreateWaitStateInput = {
  executionId: string;
  workflowId: string;
  runId: string;
  nodeId: string;
  nodeName: string;
  waitType: "delay" | "event";
  /**
   * What `POST /workflows/waits/:token/resume` unparks this run by. Generated per
   * park rather than authored, because two runs at one node would collide on a
   * token decided at design time.
   */
  resumeToken?: string;
  /** Target timestamp as ISO 8601; the adapter converts it for storage. */
  waitUntilIso?: string;
  /**
   * The Event names this wait parks on, which the delivery fan-out finds the run
   * by. Empty for a wait on a clock, which no Event reaches.
   */
  subscribedEvents?: string[];
  metadata?: Record<string, unknown>;
};

export type MarkWaitStateStatusInput = {
  waitStateId: string;
  status: "resumed" | "timed_out" | "cancelled";
};

/**
 * A Cancel Event's request against one run, as the engine reads it back. The
 * payload is what the canceling Event carried, which the Canceled branch
 * addresses as the entry node's output.
 */
export type PendingCancel = {
  eventName: string | null;
  payload: JsonObject | null;
};

export type CompleteRunInput = {
  executionId: string;
  status: "completed" | "failed" | "canceled";
  output?: unknown;
  error?: string;
  /** Epoch milliseconds the run started, used to derive its duration. */
  startTime: number;
};

export type WorkflowStore = {
  /** Opens a step-log row and returns the handle that closes it. */
  startStepLog(input: StartStepLogInput): Promise<WorkflowStepLogHandle>;
  /** Closes a row opened by `startStepLog`. */
  completeStepLog(input: CompleteStepLogInput): Promise<void>;
  /** Appends an entry to the run's timeline. */
  recordAuditEvent(input: RecordAuditEventInput): Promise<void>;
  /**
   * Records that the run is parked on a Wait node; returns the new row's id,
   * or undefined when the execution lost a race with a cancellation and may
   * no longer park.
   */
  createWaitState(
    input: CreateWaitStateInput
  ): Promise<{ waitStateId: string } | undefined>;
  /** Closes out a wait row once the run resumes, times out, or is cancelled. */
  markWaitStateStatus(input: MarkWaitStateStatusInput): Promise<void>;
  /** Moves an execution back from "waiting" to "running" after a wait. */
  markExecutionRunning(input: { executionId: string }): Promise<void>;
  /**
   * Whether a Cancel Event has claimed this run, and what it carried. Read at
   * each node boundary inside a step, so the answer is memoized and a replay
   * takes the branch the first pass took.
   */
  readPendingCancel(executionId: string): Promise<PendingCancel | null>;
  /**
   * Writes the terminal state of the run. Returns whether this write
   * recorded it — false when a cancellation already made the row terminal,
   * in which case the run's own completion must not be announced either.
   */
  completeRun(input: CompleteRunInput): Promise<boolean>;
};

/**
 * Store that drops everything written to it. Used when a run should leave no
 * persisted trace - the engine's own fallback, and the honest default for
 * callers that have no database.
 */
export const noopWorkflowStore: WorkflowStore = {
  startStepLog: () => Promise.resolve({ logId: "", startTime: Date.now() }),
  completeStepLog: () => Promise.resolve(),
  recordAuditEvent: () => Promise.resolve(),
  createWaitState: () => Promise.resolve({ waitStateId: "" }),
  markWaitStateStatus: () => Promise.resolve(),
  markExecutionRunning: () => Promise.resolve(),
  readPendingCancel: () => Promise.resolve(null),
  completeRun: () => Promise.resolve(true),
};
