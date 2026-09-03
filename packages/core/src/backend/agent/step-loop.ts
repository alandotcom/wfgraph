import { Effect, Stream } from "effect";

/** The maximum number of model calls one agent turn can make. */
export const AGENT_TURN_STEP_LIMIT = 48;

/**
 * Repeat one model step while its response calls a tool.
 *
 * The step limit applies to model calls. A final response that calls no tool
 * ends the stream and does not start another step.
 */
export function runAgentStepLoop<Part, Failure, Requirements>(input: {
  readonly limit: number;
  readonly step: () => Stream.Stream<Part, Failure, Requirements>;
  readonly calledTool: (part: Part) => boolean;
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
    return input.step().pipe(
      Stream.tap((part) =>
        Effect.sync(() => {
          if (input.calledTool(part)) {
            calledTool = true;
          }
        })
      ),
      Stream.concat(
        Stream.suspend(() => (calledTool ? run(remaining - 1) : Stream.empty))
      )
    );
  };

  return run(input.limit);
}
