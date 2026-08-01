/**
 * `WorkflowStore` adapter that keeps every write in memory so a test can assert
 * on it.
 *
 * Handles it hands back (log ids, wait-state ids) are sequential and readable,
 * which lets a test pair a `completeStepLog` call with the `startStepLog` that
 * opened the row.
 */

import { type JsonValue, readJsonValue } from "@rova/shared/types/json";
import type {
  CompleteRunInput,
  CompleteStepLogInput,
  CreateWaitStateInput,
  MarkWaitStateStatusInput,
  RecordAuditEventInput,
  StartStepLogInput,
  WorkflowStore,
} from "#src/backend/engine/store";

/** The input each store method receives, keyed by method name. */
type StoreCallInputs = {
  startStepLog: StartStepLogInput;
  completeStepLog: CompleteStepLogInput;
  recordAuditEvent: RecordAuditEventInput;
  createWaitState: CreateWaitStateInput;
  markWaitStateStatus: MarkWaitStateStatusInput;
  markExecutionRunning: { executionId: string };
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
    markWaitStateStatus: [],
    markExecutionRunning: [],
    readPendingCancel: [],
    completeRun: [],
    readNodeOutputs: [],
    cancelOpenWork: [],
  };

  return {
    calls,

    callsOf: (method) => byMethod[method],

    reset() {
      calls.length = 0;
      for (const recordedInputs of Object.values(byMethod)) {
        recordedInputs.length = 0;
      }
    },

    startStepLog(input) {
      calls.push({ method: "startStepLog", input });
      byMethod.startStepLog.push(input);
      const logId = `log_${byMethod.startStepLog.length}`;
      nodeOfLog.set(logId, input.nodeId);
      return Promise.resolve({ logId, startTime: Date.now() });
    },

    completeStepLog(input) {
      calls.push({ method: "completeStepLog", input });
      byMethod.completeStepLog.push(input);
      const nodeId = nodeOfLog.get(input.logId);
      if (nodeId && input.status === "success") {
        nodeOutputs[nodeId] = readJsonValue(input.output);
      }
      return Promise.resolve();
    },

    recordAuditEvent(input) {
      calls.push({ method: "recordAuditEvent", input });
      byMethod.recordAuditEvent.push(input);
      return Promise.resolve();
    },

    createWaitState(input) {
      calls.push({ method: "createWaitState", input });
      byMethod.createWaitState.push(input);
      return Promise.resolve({
        waitStateId: `wait_state_${byMethod.createWaitState.length}`,
      });
    },

    markWaitStateStatus(input) {
      calls.push({ method: "markWaitStateStatus", input });
      byMethod.markWaitStateStatus.push(input);
      return Promise.resolve();
    },

    markExecutionRunning(input) {
      calls.push({ method: "markExecutionRunning", input });
      byMethod.markExecutionRunning.push(input);
      return Promise.resolve();
    },

    readPendingCancel(executionId) {
      const input = { executionId };
      calls.push({ method: "readPendingCancel", input });
      byMethod.readPendingCancel.push(input);
      return Promise.resolve(null);
    },

    completeRun(input) {
      calls.push({ method: "completeRun", input });
      byMethod.completeRun.push(input);
      return Promise.resolve(true);
    },

    // Answered from the rows this adapter was asked to close, which is the
    // database's own answer in miniature: a branch run reads what the run above
    // it wrote, and a node whose row never closed is absent here too.
    readNodeOutputs(executionId) {
      const input = { executionId };
      calls.push({ method: "readNodeOutputs", input });
      byMethod.readNodeOutputs.push(input);
      return Promise.resolve({ ...nodeOutputs });
    },

    cancelOpenWork(input) {
      calls.push({ method: "cancelOpenWork", input });
      byMethod.cancelOpenWork.push(input);
      return Promise.resolve();
    },
  };
}
