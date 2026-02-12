import { logStepCompleteDb, logStepStartDb } from "@/lib/workflow-logging";

type StepLogStartInput = {
  executionId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  input?: unknown;
};

type StepLogCompleteInput = {
  logId: string;
  startTime: number;
  status: "success" | "error";
  output?: unknown;
  error?: string;
};

export async function stepLogStartStep(input: StepLogStartInput) {
  return await logStepStartDb(input);
}
stepLogStartStep.maxRetries = 0;

export async function stepLogCompleteStep(input: StepLogCompleteInput) {
  await logStepCompleteDb(input);
  return { success: true };
}
stepLogCompleteStep.maxRetries = 0;
