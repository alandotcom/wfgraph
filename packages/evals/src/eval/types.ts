/**
 * The contract between an eval suite, the harness it runs, and the judges that
 * score the run. Everything a case records lands on `task.meta.eval`, which is
 * sent from the worker to the reporters and written whole into the JSON report,
 * so every recorded value is JSON.
 */
import type { JsonObject, JsonValue } from "@wfgraph/shared/types/json";

/** One step of the conversation a harness ran, in the order it happened. */
export type TranscriptEvent =
  | {
      type: "message";
      role: "user" | "assistant";
      content: string;
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments: JsonObject;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      content: JsonObject;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      error: { message: string; type: string };
    };

/** What a run cost, in the units the report prints. */
export type HarnessUsage = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  toolCalls: number;
  metadata: JsonObject;
};

export type HarnessContext = {
  /** Aborted when Vitest times the case out or the run is cancelled. */
  signal: AbortSignal | undefined;
  /** Keeps a named value in the report beside the case, for reading afterwards. */
  setArtifact: (name: string, value: JsonValue) => void;
};

export type HarnessResult<Output> = {
  output: Output;
  events: TranscriptEvent[];
  usage: HarnessUsage;
  errors: string[];
};

/** Runs the system under assessment once for one scenario input. */
export type Harness<Input, Output> = {
  name: string;
  run: (
    input: Input,
    context: HarnessContext
  ) => Promise<HarnessResult<Output>>;
};

/** A score from 0 to 1, where 1 is a pass, and the sentence explaining it. */
export type JudgeResult = {
  score: number;
  rationale: string;
  /** Whatever else the judge read, kept in the report beside the score. */
  metadata?: JsonObject | undefined;
};

export type Judge<Input, Output> = {
  name: string;
  assess: (run: { input: Input; output: Output }) => JudgeResult;
};

export type JudgeScore = JudgeResult & {
  judge: string;
  /** A gating score below 1 fails the case; an advisory one is only recorded. */
  gating: boolean;
};

/**
 * One case as the report holds it. A harness that threw leaves `output` and
 * `usage` absent, no scores, and its message in `errors`.
 */
export type EvalCaseRecord = {
  harness: string;
  durationMs: number;
  scores: JudgeScore[];
  output?: JsonValue;
  events: TranscriptEvent[];
  usage?: HarnessUsage;
  errors: string[];
  artifacts: Record<string, JsonValue>;
};

declare module "vitest" {
  interface TaskMeta {
    eval?: EvalCaseRecord;
  }
}
