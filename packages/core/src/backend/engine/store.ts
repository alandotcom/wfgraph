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
 * round-trip through the durable runtime's storage. A step's own payload is
 * still `unknown` here, because that is all a step result carries; the adapter
 * that stores it is where it is read back as JSON.
 */

import type {
  JsonObject,
  JsonObjectDraft,
  JsonValue,
} from "@wfgraph/shared/types/json";
import type { WaitSignalType } from "@wfgraph/shared/lifecycle/wait-signal";
import { Effect } from "effect";
import type { EngineFailure } from "#src/backend/engine/engine-failure";
import type { DatabaseError } from "#src/backend/lib/effect/database";

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
  /**
   * Milliseconds the work this row covers took, measured by the caller. The row
   * cannot be timed from its own open here: that write is a memoized step, so
   * its clock belongs to whichever attempt inserted the row.
   */
  durationMs: number;
  status: "success" | "error";
  output?: unknown;
  error?: string | undefined;
};

export type RecordAuditEventInput = {
  workflowId: string;
  executionId: string;
  eventType: WorkflowRunAuditEventType;
  message: string;
  metadata?: JsonObjectDraft | undefined;
};

export type CreateWaitStateInput = {
  executionId: string;
  workflowId: string;
  runId: string;
  nodeId: string;
  nodeName: string;
  waitType: "delay" | "event";
  /**
   * What the authenticated runs panel uses to address this parked run. Generated
   * per park because two runs at one node would collide on an authored token.
   */
  resumeToken?: string | undefined;
  /** Target timestamp as ISO 8601; the adapter converts it for storage. */
  waitUntilIso?: string | undefined;
  /**
   * The Event names this wait parks on, which the delivery fan-out finds the run
   * by. Empty for a wait on a clock, which no Event reaches.
   */
  subscribedEvents?: string[] | undefined;
  metadata?: JsonObjectDraft | undefined;
};

/**
 * A wait row parked again, after a Migration moved the run to a newer Workflow
 * Version while it was waiting.
 *
 * The row keeps its id and its `waiting` status, so everything already
 * addressing this park keeps addressing it. Every other field of the park is
 * written over, because the new version's config decides all of them: a Wait
 * that changed mode writes a different `waitType`, an event wait that lost its
 * subscriptions writes an empty list, and a delay wait writes a null token.
 */
export type ReparkWaitStateInput = {
  waitStateId: string;
  waitType: "delay" | "event";
  /** Target timestamp as ISO 8601, and null for a wait with no target. */
  waitUntilIso: string | null;
  /** The Event names a delivery finds this row by. Empty for a delay wait. */
  subscribedEvents: string[];
  /** The token addressing this park, and null for a delay wait, which has none. */
  resumeToken: string | null;
  metadata: JsonObject;
};

/** The statuses a wait row can be read back in. */
export type WaitStateStatus =
  | "waiting"
  | "resuming"
  | "resumed"
  | "timed_out"
  | "cancelled";

/**
 * The wake a resume claim recorded on a wait row before it sent the signal.
 *
 * A run woken by a Migration is still `waiting` between that wake and its next
 * park, so a resume can claim the row in the meantime and send a signal nothing
 * is parked on. The claim writes what it is about onto the row, which is what
 * lets the next park read the wake it missed instead of waiting forever.
 */
export type WaitStateArrival = {
  signalType: WaitSignalType;
  /** The Event that arrived, and null for a resume that named none. */
  eventName: string | null;
  payload: JsonObject;
};

/** A wait row as the engine reads it back after a re-park was refused. */
export type WaitStateSnapshot = {
  status: WaitStateStatus;
  arrival: WaitStateArrival | null;
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
  failure?: EngineFailure | undefined;
};

export type WorkflowStore = {
  /** Opens a step-log row and returns the handle that closes it. */
  startStepLog(
    input: StartStepLogInput
  ): Effect.Effect<WorkflowStepLogHandle, DatabaseError>;
  /** Closes a row opened by `startStepLog`. */
  completeStepLog(
    input: CompleteStepLogInput
  ): Effect.Effect<void, DatabaseError>;
  /** Appends an entry to the run's timeline. */
  recordAuditEvent(
    input: RecordAuditEventInput
  ): Effect.Effect<void, DatabaseError>;
  /**
   * Records that the run is parked on a Wait node; returns the new row's id,
   * or undefined when the execution lost a race with a cancellation and may
   * no longer park.
   */
  createWaitState(
    input: CreateWaitStateInput
  ): Effect.Effect<{ waitStateId: string } | undefined, DatabaseError>;
  /**
   * Writes a re-parked wait's whole park onto the row it already holds. True
   * when a row still `waiting` was written, and false when the row has left
   * `waiting`, which the caller answers by reading it back.
   */
  reparkWaitState(
    input: ReparkWaitStateInput
  ): Effect.Effect<boolean, DatabaseError>;
  /**
   * One wait row as it stands, or null when no row holds that id. Read after a
   * refused re-park, to find out what moved the row.
   */
  readWaitState(
    waitStateId: string
  ): Effect.Effect<WaitStateSnapshot | null, DatabaseError>;
  /**
   * The Workflow Version this execution row pins, or null when the row is gone.
   *
   * A Migration moves that pointer while a run is parked. The Wait node compares
   * it against the version the running body loaded, so an attempt that would
   * carry on under the superseded graph fails its step and is retried against
   * the new one.
   */
  readPinnedVersionId(
    executionId: string
  ): Effect.Effect<string | null, DatabaseError>;
  /** Closes out a wait row once the run resumes, times out, or is cancelled. */
  markWaitStateStatus(
    input: MarkWaitStateStatusInput
  ): Effect.Effect<void, DatabaseError>;
  /** Moves an execution back from "waiting" to "running" after a wait. */
  markExecutionRunning(input: {
    executionId: string;
  }): Effect.Effect<void, DatabaseError>;
  /**
   * Whether a Cancel Event has claimed this run, and what it carried. Read at
   * each node boundary inside a step, so the answer is memoized and a replay
   * takes the branch the first pass took.
   */
  readPendingCancel(
    executionId: string
  ): Effect.Effect<PendingCancel | null, DatabaseError>;
  /**
   * Writes the terminal state of the run. True when this write claimed the row
   * and false when a terminal status already won the race. A database refusal
   * remains in the error channel; the terminal-record policy converts it to the
   * same no-audit outcome after logging it distinctly.
   */
  completeRun(input: CompleteRunInput): Effect.Effect<boolean, DatabaseError>;
  /**
   * What the nodes of this run that have already finished left behind, keyed by
   * node id. A branch run starts partway down the graph, so this is how the
   * templates behind a Wait reach the outputs above it. A node absent here
   * either has not run or produced nothing, and both read the same downstream.
   */
  readNodeOutputs(
    executionId: string
  ): Effect.Effect<Record<string, JsonValue>, DatabaseError>;
  /**
   * Closes every node row still open and every wait still waiting, as cancelled.
   *
   * The caller states when this is safe: nothing may still be writing to those
   * rows. See `NodeScheduler.sweepKilledBranchWork`, its one call site.
   */
  cancelOpenWork(input: {
    executionId: string;
  }): Effect.Effect<void, DatabaseError>;
};

/**
 * Store that drops everything written to it, for a test whose subject is not the
 * trace. `executeWorkflow` requires a store, so nothing reaches this by omission.
 */
export const noopWorkflowStore: WorkflowStore = {
  startStepLog: () => Effect.sync(() => ({ logId: "", startTime: Date.now() })),
  completeStepLog: () => Effect.void,
  recordAuditEvent: () => Effect.void,
  createWaitState: () => Effect.succeed({ waitStateId: "" }),
  reparkWaitState: () => Effect.succeed(true),
  readWaitState: () => Effect.succeed(null),
  readPinnedVersionId: () => Effect.succeed(null),
  markWaitStateStatus: () => Effect.void,
  markExecutionRunning: () => Effect.void,
  readPendingCancel: () => Effect.succeed(null),
  completeRun: () => Effect.succeed(true),
  readNodeOutputs: () => Effect.succeed({}),
  cancelOpenWork: () => Effect.void,
};
