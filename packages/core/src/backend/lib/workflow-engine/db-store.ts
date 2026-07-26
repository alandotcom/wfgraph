/**
 * Postgres-backed `WorkflowStore`: the adapter real runs use.
 *
 * It is the only place that knows both the engine's persistence port and the
 * database helpers behind it, which is what keeps the engine module free of db
 * imports. Everything here is a thin translation - no policy, no branching on
 * run state.
 */

import { logWorkflowComplete } from "@/backend/lib/steps/step-handler";
import { logWorkflowAuditEvent } from "@/backend/lib/workflow-audit";
import {
  logStepCompleteDb,
  logStepStartDb,
} from "@/backend/lib/workflow-logging";
import {
  createWaitState,
  markExecutionRunning,
  markWaitStateStatus,
} from "@/backend/lib/workflow-wait-state";
import type { WorkflowStore } from "./store";

export const dbWorkflowStore: WorkflowStore = {
  startStepLog: (input) => logStepStartDb(input),

  completeStepLog: (input) => logStepCompleteDb(input),

  recordAuditEvent: (input) => logWorkflowAuditEvent(input),

  createWaitState: async (input) => {
    // The port speaks ISO strings so wait-state writes stay JSON-safe across a
    // memoized step; the table wants a Date.
    const waitState = await createWaitState({
      ...input,
      waitUntil: input.waitUntilIso ? new Date(input.waitUntilIso) : undefined,
    });

    return { waitStateId: waitState.id };
  },

  markWaitStateStatus: async (input) => {
    await markWaitStateStatus(input);
  },

  markExecutionRunning: async (input) => {
    await markExecutionRunning(input.executionId);
  },

  completeRun: (input) => logWorkflowComplete(input),
};
