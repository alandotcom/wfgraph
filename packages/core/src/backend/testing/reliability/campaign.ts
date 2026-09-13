import * as fc from "fast-check";

type ScenarioParameters<S> = Pick<
  fc.Parameters<[S]>,
  "numRuns" | "examples" | "seed" | "path"
>;

type ScenarioResult = Pick<
  fc.RunDetails<unknown>,
  | "failed"
  | "counterexample"
  | "counterexamplePath"
  | "seed"
  | "numShrinks"
  | "errorInstance"
  | "interrupted"
>;

export type ScenarioCheck = {
  details: ScenarioResult;
  reproduced: boolean;
  interrupted: boolean;
};

/** Shrinking has its own budget; an interrupted trial must release its resources. */
export async function checkScenarios<S>(input: {
  arbitrary: fc.Arbitrary<S>;
  execute: (value: S) => Promise<void>;
  parameters: ScenarioParameters<S>;
  shrinkTimeMs?: number | undefined;
}): Promise<ScenarioCheck> {
  const activeTrials = new Set<Promise<void>>();
  const property = fc.asyncProperty(input.arbitrary, (value) => {
    const trial = input.execute(value);
    activeTrials.add(trial);
    return trial.finally(() => {
      activeTrials.delete(trial);
    });
  });
  const initialResult = await fc.check(property, {
    ...input.parameters,
    endOnFailure: true,
  });
  let replayResult: ScenarioResult = initialResult;
  if (initialResult.failed && initialResult.counterexamplePath !== null) {
    replayResult = await fc.check(property, {
      ...input.parameters,
      numRuns: 1,
      path: initialResult.counterexamplePath,
      plugins: [
        fc.interruptAfterTimeLimit(input.shrinkTimeMs ?? 120_000, {
          failOnInterrupt: true,
        }),
      ],
    });
  }

  // fast-check interrupts its wait, not the trial that owns the live resources.
  await Promise.allSettled(activeTrials);
  return {
    details:
      replayResult.failed && replayResult.counterexample !== null
        ? replayResult
        : initialResult,
    reproduced: replayResult.failed,
    interrupted: replayResult.interrupted,
  };
}

export async function withCleanup<A extends { close: () => Promise<void> }>(
  acquire: () => Promise<A>,
  run: (resource: A) => Promise<void>
): Promise<void> {
  const resource = await acquire();
  let failure: unknown;
  try {
    await run(resource);
  } catch (error) {
    failure = error;
  }
  try {
    await resource.close();
  } catch (error) {
    if (failure) {
      throw new AggregateError(
        [failure, error],
        "Scenario and cleanup failed",
        {
          cause: error,
        }
      );
    }
    throw error;
  }
  if (failure) throw failure;
}
