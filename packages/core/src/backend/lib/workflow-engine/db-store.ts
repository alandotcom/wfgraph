/**
 * Postgres-backed `WorkflowStore`: the adapter real runs use.
 *
 * It is the only place that knows both the engine's persistence port and the
 * database helpers behind it, which is what keeps the engine module free of db
 * imports. Everything here is a thin translation - no policy, no branching on
 * run state.
 */

import { z } from "zod";
import { logWorkflowComplete } from "@/backend/lib/steps/step-handler";
import { redactSensitiveData } from "@/backend/lib/utils/redact";
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
import { isoTimestampToDate } from "@rova/shared/types/timestamp";
import type { WorkflowStore } from "./store";

export const dbWorkflowStore: WorkflowStore = {
  // Step payloads can carry secrets pulled in through templates, so they are
  // scrubbed here rather than at each call site - this is the last point before
  // they reach a table.
  startStepLog: (input) =>
    logStepStartDb({ ...input, input: redactSensitiveData(input.input) }),

  completeStepLog: (input) =>
    logStepCompleteDb({ ...input, output: redactSensitiveData(input.output) }),

  recordAuditEvent: (input) => logWorkflowAuditEvent(input),

  createWaitState: async (input) => {
    // The port speaks ISO strings so wait-state writes stay JSON-safe across a
    // memoized step; the table wants a Date. The engine produced this string
    // through the same codec, so a string that will not decode means the value
    // was corrupted in between, and the write fails rather than storing a wait
    // target nothing can resume from.
    const waitState = await createWaitState({
      ...input,
      waitUntil: input.waitUntilIso
        ? z.decode(isoTimestampToDate, input.waitUntilIso)
        : undefined,
    });

    return waitState ? { waitStateId: waitState.id } : undefined;
  },

  markWaitStateStatus: async (input) => {
    await markWaitStateStatus(input);
  },

  markExecutionRunning: async (input) => {
    await markExecutionRunning(input.executionId);
  },

  completeRun: (input) => logWorkflowComplete(input),
};
