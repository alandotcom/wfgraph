/**
 * `WorkflowStore` adapter that keeps every write in memory so a test can assert
 * on it.
 *
 * Handles it hands back (log ids, wait-state ids) are sequential and readable,
 * which lets a test pair a `completeStepLog` call with the `startStepLog` that
 * opened the row.
 */

import {
  claimKindAdmits,
  type ExecutionSide,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  answerForOneRun,
  planRunEnds,
  type RunEndEntry,
} from "@wfgraph/shared/lifecycle/run-ending";
import { Effect } from "effect";
import type { WaitArrival } from "@wfgraph/shared/lifecycle/wait-signal";
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
  WorkflowStepLogHandle,
  WorkflowRunAuditEventType,
  WorkflowStore,
} from "#src/backend/engine/store";

/**
 * A timeline entry the recording store keeps: one `recordAuditEvent` wrote, or
 * the one a `completeRun` that ended the run wrote.
 */
export type RecordedTimelineEntry = Omit<RecordAuditEventInput, "eventType"> & {
  eventType: WorkflowRunAuditEventType | RunEndEntry["eventType"];
};

/** The input each store method receives, keyed by method name. */
type StoreCallInputs = {
  startStepLog: StartStepLogInput;
  completeStepLog: CompleteStepLogInput;
  recordAuditEvent: RecordAuditEventInput;
  createWaitState: CreateWaitStateInput;
  reparkWaitState: ReparkWaitStateInput;
  markWaitStateStatus: MarkWaitStateStatusInput;
  settleWaitTimeout: { waitStateId: string };
  readWaitState: { waitStateId: string };
  markExecutionRunning: {
    executionId: string;
    workflowVersionId: string;
    side: ExecutionSide;
  };
  markExecutionWaitingIfParked: { executionId: string };
  admitNode: { executionId: string };
  requestExit: RequestExecutionExitInput;
  readTerminationState: { executionId: string };
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
  /**
   * Every timeline entry the store wrote, in order: each `recordAuditEvent`,
   * and the entry of each `completeRun` that ended the run.
   */
  readonly timeline: RecordedTimelineEntry[];
  /**
   * Set to `undefined` to model a first park the execution row refused, which
   * is a run that ended or was moved to another Workflow Version. Left unset,
   * every park opens a row, subject to the claim on `terminationState`.
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
  /** What `settleWaitTimeout` finds already persisted on the row. */
  settleWaitTimeoutAnswer: WaitArrival | null;
  /**
   * What `markExecutionRunning` answers, subject to the claim on
   * `terminationState`. False models a Migration landing between a Wait's wake
   * and its resume, which the resume treats as a step failure.
   */
  markRunningAnswer: boolean;
  /**
   * What `markExecutionWaitingIfParked` answers. True models a pass that ends
   * with a Wait of the run still parked.
   */
  waitingIfParkedAnswer: boolean;
  /** Shared execution boundary state used by node-admission and exit tests. */
  terminationState: ExecutionTerminationState | null;
  /**
   * The run's own columns a terminal entry reads, as a database backend reads
   * them off the execution row. Defaults to a live run of `workflow_1`.
   */
  run: { workflowId: string; runMode: "live" | "test" };
  /**
   * The deadline the last accepted park or re-park wrote on a wait row this
   * store opened, by the id it answered for the row. `driveWithReplay` reads a park's
   * deadline here (`ReplayWaitRows`).
   */
  waitUntilOf(waitStateId: string): Date | undefined;
  /**
   * The log id `startStepLog` answered for a node's row, or undefined before
   * the node's first open.
   */
  logIdOf(nodeId: string): string | undefined;
  reset(): void;
};

/**
 * The claim guard both real backends put on a park and on a resume, modelled
 * here because a Canceled-side Wait parking at all depends on it.
 */
function claimAdmits(
  terminationState: ExecutionTerminationState | null,
  side: ExecutionSide
): boolean {
  return claimKindAdmits(terminationState?.claim?.kind ?? null, side);
}

export function createRecordingWorkflowStore(): RecordingWorkflowStore {
  const calls: RecordedStoreCall[] = [];
  const timeline: RecordedTimelineEntry[] = [];
  const byMethod: { [M in StoreMethod]: StoreCallInputs[M][] } = {
    startStepLog: [],
    completeStepLog: [],
    recordAuditEvent: [],
    createWaitState: [],
    reparkWaitState: [],
    markWaitStateStatus: [],
    settleWaitTimeout: [],
    readWaitState: [],
    markExecutionRunning: [],
    markExecutionWaitingIfParked: [],
    admitNode: [],
    requestExit: [],
    readTerminationState: [],
    readPendingCancel: [],
    completeRun: [],
  };

  const waitUntilById = new Map<string, Date>();
  /** The handle `startStepLog` answers, by node id. */
  const logHandles = new Map<
    string,
    Omit<WorkflowStepLogHandle, "finishedBefore">
  >();
  /**
   * Each row's status by log id, under the close rule both backends apply: a
   * success is never overwritten, and a second error keeps the first.
   */
  const logStatuses = new Map<string, "running" | "success" | "error">();
  const recordWaitUntil = (
    waitStateId: string,
    waitUntilIso: string | null | undefined
  ) => {
    if (waitUntilIso === null || waitUntilIso === undefined) {
      waitUntilById.delete(waitStateId);
    } else {
      waitUntilById.set(waitStateId, new Date(waitUntilIso));
    }
  };

  const store: RecordingWorkflowStore = {
    calls,

    callsOf: (method) => byMethod[method],

    timeline,

    createWaitStateAnswer: "open",
    reparkAnswer: { ok: true },
    waitState: null,
    settleWaitTimeoutAnswer: null,
    markRunningAnswer: true,
    waitingIfParkedAnswer: false,
    terminationState: null,
    run: { workflowId: "workflow_1", runMode: "live" },

    waitUntilOf: (waitStateId) => waitUntilById.get(waitStateId),

    logIdOf: (nodeId) => logHandles.get(nodeId)?.logId,

    reset() {
      calls.length = 0;
      timeline.length = 0;
      waitUntilById.clear();
      logHandles.clear();
      logStatuses.clear();
      for (const recordedInputs of Object.values(byMethod)) {
        recordedInputs.length = 0;
      }
    },

    // One row per node, numbered in the order the nodes first open, so an
    // open that runs again answers the handle it answered before, as the
    // database store does.
    startStepLog(input) {
      return Effect.sync(() => {
        calls.push({ method: "startStepLog", input });
        byMethod.startStepLog.push(input);
        const handle = logHandles.get(input.nodeId) ?? {
          logId: `log_${logHandles.size + 1}`,
          startTime: Date.now(),
        };
        logHandles.set(input.nodeId, handle);
        const status = logStatuses.get(handle.logId);
        if (status === undefined) logStatuses.set(handle.logId, "running");
        return { ...handle, finishedBefore: status === "success" };
      });
    },

    completeStepLog(input) {
      return Effect.sync(() => {
        calls.push({ method: "completeStepLog", input });
        byMethod.completeStepLog.push(input);
        if (logStatuses.get(input.logId) === "running") {
          logStatuses.set(input.logId, input.status);
        } else if (
          logStatuses.get(input.logId) === "error" &&
          input.status === "success"
        ) {
          logStatuses.set(input.logId, "success");
        }
      });
    },

    recordAuditEvent(input) {
      return Effect.sync(() => {
        calls.push({ method: "recordAuditEvent", input });
        byMethod.recordAuditEvent.push(input);
        timeline.push(input);
      });
    },

    createWaitState(input) {
      return Effect.sync(() => {
        calls.push({ method: "createWaitState", input });
        byMethod.createWaitState.push(input);
        const answer = store.createWaitStateAnswer;
        if (answer !== "open") {
          if (answer) recordWaitUntil(answer.waitStateId, input.waitUntilIso);
          return answer;
        }
        if (!claimAdmits(store.terminationState, input.side)) return undefined;
        const waitStateId = `wait_state_${byMethod.createWaitState.length}`;
        recordWaitUntil(waitStateId, input.waitUntilIso);
        return { waitStateId };
      });
    },

    reparkWaitState(input) {
      return Effect.sync(() => {
        calls.push({ method: "reparkWaitState", input });
        byMethod.reparkWaitState.push(input);
        if (store.reparkAnswer.ok) {
          recordWaitUntil(input.waitStateId, input.waitUntilIso);
        }
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

    settleWaitTimeout(waitStateId) {
      return Effect.sync(() => {
        const input = { waitStateId };
        calls.push({ method: "settleWaitTimeout", input });
        byMethod.settleWaitTimeout.push(input);
        return store.settleWaitTimeoutAnswer;
      });
    },

    markExecutionRunning(input) {
      return Effect.sync(() => {
        calls.push({ method: "markExecutionRunning", input });
        byMethod.markExecutionRunning.push(input);
        return (
          store.markRunningAnswer &&
          claimAdmits(store.terminationState, input.side)
        );
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

    // The boundary read and the claim guard answer from the one row here, as
    // they do in both backends: a case that lands a claim gets it from either.
    readPendingCancel(executionId) {
      return Effect.sync(() => {
        const input = { executionId };
        calls.push({ method: "readPendingCancel", input });
        byMethod.readPendingCancel.push(input);
        const claim = store.terminationState?.claim;
        return claim?.kind === "cancel"
          ? { eventName: claim.eventName, payload: claim.payload }
          : null;
      });
    },

    completeRun(input) {
      return Effect.sync(() => {
        calls.push({ method: "completeRun", input });
        byMethod.completeRun.push(input);
        const current = store.terminationState;
        const plan = planRunEnds(
          [
            {
              executionId: input.executionId,
              workflowId: store.run.workflowId,
              status: current?.status ?? "running",
              claim: current?.claim ?? null,
              runMode: store.run.runMode,
            },
          ],
          input.verdict
        );
        for (const ended of plan.ended) {
          store.terminationState = {
            status: ended.status,
            claim: current?.claim ?? null,
            didWrite: true,
          };
          timeline.push(ended.entry);
        }
        return answerForOneRun(plan);
      });
    },
  };

  return store;
}
