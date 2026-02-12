import {
  createWaitState,
  markExecutionRunning,
  markWaitStateStatus,
} from "@/lib/workflow-wait-state";

type CreateWaitStateStepInput = {
  executionId: string;
  workflowId: string;
  runId: string;
  nodeId: string;
  nodeName: string;
  waitType: "delay" | "hook";
  hookToken?: string;
  waitUntilIso?: string;
  correlationKey?: string;
  metadata?: Record<string, unknown>;
};

type MarkWaitStateStatusStepInput = {
  waitStateId: string;
  status: "resumed" | "timed_out" | "cancelled";
};

type MarkExecutionRunningStepInput = {
  executionId: string;
};

export async function createWaitStateStep(input: CreateWaitStateStepInput) {
  const waitState = await createWaitState({
    ...input,
    waitUntil: input.waitUntilIso ? new Date(input.waitUntilIso) : undefined,
  });

  return {
    id: waitState.id,
  };
}
createWaitStateStep.maxRetries = 0;

export async function markWaitStateStatusStep(
  input: MarkWaitStateStatusStepInput
) {
  await markWaitStateStatus(input);
  return { success: true };
}
markWaitStateStatusStep.maxRetries = 0;

export async function markExecutionRunningStep(
  input: MarkExecutionRunningStepInput
) {
  await markExecutionRunning(input.executionId);
  return { success: true };
}
markExecutionRunningStep.maxRetries = 0;
