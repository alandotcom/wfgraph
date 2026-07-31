/**
 * `WorkflowStore` adapter that keeps every write in memory so a test can assert
 * on it.
 *
 * Handles it hands back (log ids, wait-state ids) are sequential and readable,
 * which lets a test pair a `completeStepLog` call with the `startStepLog` that
 * opened the row.
 */

import type {
  CompleteRunInput,
  CompleteStepLogInput,
  CreateWaitStateInput,
  MarkWaitStateStatusInput,
  RecordAuditEventInput,
  StartStepLogInput,
  WorkflowStore,
} from "./store";

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
  const byMethod: { [M in StoreMethod]: StoreCallInputs[M][] } = {
    startStepLog: [],
    completeStepLog: [],
    recordAuditEvent: [],
    createWaitState: [],
    markWaitStateStatus: [],
    markExecutionRunning: [],
    readPendingCancel: [],
    completeRun: [],
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
      return Promise.resolve({
        logId: `log_${byMethod.startStepLog.length}`,
        startTime: Date.now(),
      });
    },

    completeStepLog(input) {
      calls.push({ method: "completeStepLog", input });
      byMethod.completeStepLog.push(input);
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
  };
}
