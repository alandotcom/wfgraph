/**
 * `WorkflowStore` adapter that keeps every write in memory so a test can assert
 * on it.
 *
 * Handles it hands back (log ids, wait-state ids) are sequential and readable,
 * which lets a test pair a `completeStepLog` call with the `startStepLog` that
 * opened the row.
 */

import { type JsonValue, readJsonValue } from "@wfgraph/shared/types/json";
import { Effect } from "effect";
import type {
  CompleteRunInput,
  CompleteStepLogInput,
  CreateWaitStateInput,
  ExecutionTerminationState,
  MarkWaitStateStatusInput,
  ReparkWaitStateInput,
  ReparkWaitStateOutcome,
  RecordAuditEventInput,
  RequestExecutionExitInput,
  StartStepLogInput,
  WaitStateSnapshot,
  WorkflowStore,
} from "#src/backend/engine/store";

/** The input each store method receives, keyed by method name. */
type StoreCallInputs = {
  startStepLog: StartStepLogInput;
  completeStepLog: CompleteStepLogInput;
  recordAuditEvent: RecordAuditEventInput;
  createWaitState: CreateWaitStateInput;
  reparkWaitState: ReparkWaitStateInput;
  markWaitStateStatus: MarkWaitStateStatusInput;
  readWaitState: { waitStateId: string };
  markExecutionRunning: { executionId: string; workflowVersionId: string };
  markExecutionWaitingIfParked: { executionId: string };
  admitNode: { executionId: string };
  requestExit: RequestExecutionExitInput;
  readTerminationState: { executionId: string };
  readPendingCancel: { executionId: string };
  completeRun: CompleteRunInput;
  readNodeOutputs: { executionId: string };
  cancelOpenWork: { executionId: string };
};

type StoreMethod = keyof StoreCallInputs;

export type RecordedStoreCall = {
  [M in StoreMethod]: { method: M; input: StoreCallInputs[M] };
}[StoreMethod];

export type RecordingWorkflowStore = WorkflowStore & {
  /** Every call in the order it was made, across all methods. */
  readonly calls: RecordedStoreCall[];
  /** Inputs of the calls made to one method, in order. */
  callsOf<M extends StoreMethod>(method: M): StoreCallInputs[M][];
  /**
   * Set to `undefined` to model a first park the execution row refused, which
   * is a run that ended or was moved to another Workflow Version. Left unset,
   * every park opens a row.
   */
  createWaitStateAnswer: { waitStateId: string } | undefined | "open";
  /**
   * What `reparkWaitState` answers. A refusal models the guard that turned the
   * write down: `not_waiting` is a row that left `waiting` between the wake and
   * the re-park, `version_moved` is a Migration landing inside the park.
   */
  reparkAnswer: ReparkWaitStateOutcome;
  /** What `readWaitState` answers, for the case a re-park was refused. */
  waitState: WaitStateSnapshot | null;
  /**
   * What `markExecutionRunning` answers. False models a Migration landing
   * between a Wait's wake and its resume, which the resume treats as a step
   * failure.
   */
  markRunningAnswer: boolean;
  /**
   * What `markExecutionWaitingIfParked` answers. True models a run whose sibling
   * branch is still parked when this branch finishes.
   */
  waitingIfParkedAnswer: boolean;
  /** Shared execution boundary state used by node-admission and exit tests. */
  terminationState: ExecutionTerminationState | null;
  reset(): void;
};

export function createRecordingWorkflowStore(): RecordingWorkflowStore {
  const calls: RecordedStoreCall[] = [];
  /** Which node each open row belongs to, so a close can be attributed. */
  const nodeOfLog = new Map<string, string>();
  /** What each node that succeeded left, which is what a branch run reads back. */
  const nodeOutputs: Record<string, JsonValue> = {};
  const byMethod: { [M in StoreMethod]: StoreCallInputs[M][] } = {
    startStepLog: [],
    completeStepLog: [],
    recordAuditEvent: [],
    createWaitState: [],
    reparkWaitState: [],
    markWaitStateStatus: [],
    readWaitState: [],
    markExecutionRunning: [],
    markExecutionWaitingIfParked: [],
    admitNode: [],
    requestExit: [],
    readTerminationState: [],
    readPendingCancel: [],
    completeRun: [],
    readNodeOutputs: [],
    cancelOpenWork: [],
  };

  const store: RecordingWorkflowStore = {
    calls,

    callsOf: (method) => byMethod[method],

    createWaitStateAnswer: "open",
    reparkAnswer: { ok: true },
    waitState: null,
    markRunningAnswer: true,
    waitingIfParkedAnswer: false,
    terminationState: null,

    reset() {
      calls.length = 0;
      for (const recordedInputs of Object.values(byMethod)) {
        recordedInputs.length = 0;
      }
    },

    startStepLog(input) {
      return Effect.sync(() => {
        calls.push({ method: "startStepLog", input });
        byMethod.startStepLog.push(input);
        const logId = `log_${byMethod.startStepLog.length}`;
        nodeOfLog.set(logId, input.nodeId);
        return { logId, startTime: Date.now() };
      });
    },

    completeStepLog(input) {
      return Effect.sync(() => {
        calls.push({ method: "completeStepLog", input });
        byMethod.completeStepLog.push(input);
        const nodeId = nodeOfLog.get(input.logId);
        if (nodeId && input.status === "success") {
          nodeOutputs[nodeId] = readJsonValue(input.output);
        }
      });
    },

    recordAuditEvent(input) {
      return Effect.sync(() => {
        calls.push({ method: "recordAuditEvent", input });
        byMethod.recordAuditEvent.push(input);
      });
    },

    createWaitState(input) {
      return Effect.sync(() => {
        calls.push({ method: "createWaitState", input });
        byMethod.createWaitState.push(input);
        return store.createWaitStateAnswer === "open"
          ? { waitStateId: `wait_state_${byMethod.createWaitState.length}` }
          : store.createWaitStateAnswer;
      });
    },

    reparkWaitState(input) {
      return Effect.sync(() => {
        calls.push({ method: "reparkWaitState", input });
        byMethod.reparkWaitState.push(input);
        return store.reparkAnswer;
      });
    },

    readWaitState(waitStateId) {
      return Effect.sync(() => {
        const input = { waitStateId };
        calls.push({ method: "readWaitState", input });
        byMethod.readWaitState.push(input);
        return store.waitState;
      });
    },

    markWaitStateStatus(input) {
      return Effect.sync(() => {
        calls.push({ method: "markWaitStateStatus", input });
        byMethod.markWaitStateStatus.push(input);
      });
    },

    markExecutionRunning(input) {
      return Effect.sync(() => {
        calls.push({ method: "markExecutionRunning", input });
        byMethod.markExecutionRunning.push(input);
        return store.markRunningAnswer;
      });
    },

    markExecutionWaitingIfParked(input) {
      return Effect.sync(() => {
        calls.push({ method: "markExecutionWaitingIfParked", input });
        byMethod.markExecutionWaitingIfParked.push(input);
        return store.waitingIfParkedAnswer;
      });
    },

    admitNode(executionId) {
      return Effect.sync(() => {
        const input = { executionId };
        calls.push({ method: "admitNode", input });
        byMethod.admitNode.push(input);
        return store.terminationState === null;
      });
    },

    requestExit(input) {
      return Effect.sync(() => {
        calls.push({ method: "requestExit", input });
        byMethod.requestExit.push(input);
        if (store.terminationState) {
          return { ...store.terminationState, didWrite: false };
        }
        store.terminationState = {
          status: "running",
          claim: {
            kind: "exit",
            requestedAt: input.checkedAt,
            reason: input.reason,
            nodeId: input.nodeId,
          },
          didWrite: true,
        };
        return store.terminationState;
      });
    },

    readTerminationState(executionId) {
      return Effect.sync(() => {
        const input = { executionId };
        calls.push({ method: "readTerminationState", input });
        byMethod.readTerminationState.push(input);
        return store.terminationState;
      });
    },

    readPendingCancel(executionId) {
      return Effect.sync(() => {
        const input = { executionId };
        calls.push({ method: "readPendingCancel", input });
        byMethod.readPendingCancel.push(input);
        return null;
      });
    },

    completeRun(input) {
      return Effect.sync(() => {
        calls.push({ method: "completeRun", input });
        byMethod.completeRun.push(input);
        const current = store.terminationState;
        const claimMatches =
          !current?.claim ||
          (current.claim.kind === "exit" && input.status === "exited") ||
          (current.claim.kind === "cancel" && input.status === "canceled");
        const stillInFlight =
          !current ||
          current.status === "pending" ||
          current.status === "running" ||
          current.status === "waiting";
        if (!claimMatches || !stillInFlight) {
          return current ? { ...current, didWrite: false } : null;
        }

        store.terminationState = {
          status: input.status,
          claim: current?.claim ?? null,
          didWrite: true,
        };
        return store.terminationState;
      });
    },

    // Answered from the rows this adapter was asked to close, which is the
    // database's own answer in miniature: a branch run reads what the run above
    // it wrote, and a node whose row never closed is absent here too.
    readNodeOutputs(executionId) {
      return Effect.sync(() => {
        const input = { executionId };
        calls.push({ method: "readNodeOutputs", input });
        byMethod.readNodeOutputs.push(input);
        return { ...nodeOutputs };
      });
    },

    cancelOpenWork(input) {
      return Effect.sync(() => {
        calls.push({ method: "cancelOpenWork", input });
        byMethod.cancelOpenWork.push(input);
      });
    },
  };

  return store;
}
