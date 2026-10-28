/**
 * Binds a harness and its judges to a Vitest suite. A case calls the `run`
 * fixture with its input, which runs the harness, scores the output with every
 * judge, records the case on `task.meta.eval`, and throws when a gating judge
 * scored below 1. A harness failure is recorded and rethrown unchanged.
 */
import { describe, test } from "vitest";
import type { JsonValue } from "@wfgraph/shared/types/json";
import { getErrorMessage } from "@wfgraph/shared/utils";
import type {
  EvalCaseRecord,
  Harness,
  HarnessResult,
  Judge,
  JudgeScore,
  TranscriptEvent,
} from "#src/eval/types";

export type EvalSuiteOptions<Input, Output> = {
  harness: Harness<Input, Output>;
  /** Every one of these must score 1 for a case to pass. */
  judges: ReadonlyArray<Judge<Input, Output>>;
  /** Scored and recorded beside the gating judges, and never failing a case. */
  advisoryJudges?: ReadonlyArray<Judge<Input, Output>>;
  /** Registers the suite as skipped, for a run missing what the harness needs. */
  skip?: boolean;
};

/** Scores one output with every judge, gating judges first. */
export function scoreEvalRun<Input, Output>(
  options: Pick<EvalSuiteOptions<Input, Output>, "judges" | "advisoryJudges">,
  run: { input: Input; output: Output }
): JudgeScore[] {
  const score = (judge: Judge<Input, Output>, gating: boolean) => ({
    judge: judge.name,
    gating,
    ...judge.assess(run),
  });
  return [
    ...options.judges.map((judge) => score(judge, true)),
    ...(options.advisoryJudges ?? []).map((judge) => score(judge, false)),
  ];
}

/** The failure a case reports, or `undefined` when every gating judge passed. */
export function describeFailingScores(
  scores: readonly JudgeScore[],
  events: readonly TranscriptEvent[]
): string | undefined {
  const failing = scores.filter((score) => score.gating && score.score < 1);
  if (failing.length === 0) {
    return undefined;
  }
  const judges = failing.map(
    (score) => `${score.judge} [${score.score.toFixed(2)}]: ${score.rationale}`
  );
  const reply = events.findLast(
    (event) => event.type === "message" && event.role === "assistant"
  );
  return [
    `${failing.length} of ${scores.filter((score) => score.gating).length} gating judges scored below 1.`,
    ...judges,
    `Final reply: ${reply?.type === "message" ? reply.content : "(none)"}`,
  ].join("\n\n");
}

async function runEvalCase<Input, Output extends JsonValue>(
  options: EvalSuiteOptions<Input, Output>,
  input: Input,
  context: { task: { meta: { eval?: EvalCaseRecord } }; signal: AbortSignal }
): Promise<HarnessResult<Output>> {
  const artifacts: Record<string, JsonValue> = {};
  const startedAt = performance.now();
  let result: HarnessResult<Output>;
  try {
    result = await options.harness.run(input, {
      signal: context.signal,
      setArtifact: (name, value) => {
        artifacts[name] = value;
      },
    });
  } catch (error) {
    context.task.meta.eval = {
      harness: options.harness.name,
      durationMs: performance.now() - startedAt,
      scores: [],
      events: [],
      errors: [getErrorMessage(error)],
      artifacts,
    };
    throw error;
  }

  const scores = scoreEvalRun(options, { input, output: result.output });
  context.task.meta.eval = {
    harness: options.harness.name,
    durationMs: performance.now() - startedAt,
    scores,
    output: result.output,
    events: result.events,
    usage: result.usage,
    errors: result.errors,
    artifacts,
  };

  const failure = describeFailingScores(scores, result.events);
  if (failure !== undefined) {
    throw new Error(failure);
  }
  return result;
}

function createEvalTest<Input, Output extends JsonValue>(
  options: EvalSuiteOptions<Input, Output>
) {
  return test.extend("run", ({ task, signal }) =>
    (input: Input) =>
      runEvalCase(options, input, { task, signal }));
}

export type EvalTest<Input, Output extends JsonValue> = ReturnType<
  typeof createEvalTest<Input, Output>
>;

/** A `describe` whose cases receive a `run` fixture bound to the suite's harness. */
export function describeEval<Input, Output extends JsonValue>(
  name: string,
  options: EvalSuiteOptions<Input, Output>,
  define: (it: EvalTest<Input, Output>) => void
): void {
  describe.skipIf(options.skip ?? false)(name, () =>
    define(createEvalTest(options))
  );
}
