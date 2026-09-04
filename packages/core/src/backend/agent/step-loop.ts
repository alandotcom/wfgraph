import { Effect, Stream } from "effect";

/** The maximum number of model calls one agent turn can make. */
export const AGENT_TURN_STEP_LIMIT = 48;

export type AgentStepCompletion = {
  readonly calledTool: boolean;
  readonly failure?: Error | undefined;
};

/**
 * Repeat one model step while its response calls a tool.
 *
 * The step limit applies to model calls. A final response that calls no tool
 * ends the stream and does not start another step.
 */
export function runAgentStepLoop<Part, Failure, Requirements>(input: {
  readonly limit: number;
  readonly step: (step: number) => Stream.Stream<Part, Failure, Requirements>;
  readonly calledTool: (part: Part) => boolean;
  readonly stepCompletion: (part: Part) => AgentStepCompletion | undefined;
  readonly stepFailure?: ((part: Part) => Error | undefined) | undefined;
  readonly onStepStart?: ((step: number) => void) | undefined;
}): Stream.Stream<Part, Failure | Error, Requirements> {
  const run = (
    remaining: number
  ): Stream.Stream<Part, Failure | Error, Requirements> => {
    if (remaining <= 0) {
      return Stream.fail(
        new Error(
          `The agent stopped after ${input.limit} steps without finishing. Ask for a smaller change, or say what to do next.`
        )
      );
    }

    let calledTool = false;
    let completion: AgentStepCompletion | undefined;
    let completionCount = 0;
    let stepFailure: Error | undefined;
    const step = input.limit - remaining + 1;
    return Stream.fromEffect(Effect.sync(() => input.onStepStart?.(step))).pipe(
      Stream.flatMap(() => input.step(step)),
      Stream.tap((part) =>
        Effect.sync(() => {
          if (input.calledTool(part)) {
            calledTool = true;
          }
          const partCompletion = input.stepCompletion(part);
          if (partCompletion) {
            completion = partCompletion;
            completionCount += 1;
          }
          const partFailure = input.stepFailure?.(part);
          if (partFailure && !stepFailure) {
            stepFailure = partFailure;
          }
        })
      ),
      Stream.concat(
        Stream.suspend(() => {
          if (stepFailure) {
            return Stream.fail(stepFailure);
          }
          if (!completion) {
            return Stream.fail(
              new Error(`Model step ${step} ended without a finish part.`)
            );
          }
          if (completionCount > 1) {
            return Stream.fail(
              new Error(`Model step ${step} emitted more than one finish part.`)
            );
          }
          if (completion.failure) {
            return Stream.fail(completion.failure);
          }
          if (completion.calledTool && !calledTool) {
            return Stream.fail(
              new Error(
                `Model step ${step} reported tool calls but emitted none.`
              )
            );
          }
          if (!completion.calledTool && calledTool) {
            return Stream.fail(
              new Error(
                `Model step ${step} emitted a tool call but reported a completed response.`
              )
            );
          }
          return calledTool ? run(remaining - 1) : Stream.empty;
        })
      )
    );
  };

  return run(input.limit);
}
