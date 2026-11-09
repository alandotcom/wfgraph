/**
 * The engine's terminal write. The store decides from the verdict and the
 * run's claim what to write (`decideRunEnd`), and the timeline entry rides on
 * the terminal write, which commits both or neither.
 */

import type { StoreFailure, WorkflowStore } from "#src/backend/engine/store";
import { Effect } from "effect";
import type {
  RunEndAnswer,
  RunVerdict,
} from "@wfgraph/shared/lifecycle/run-ending";
import { redactSensitiveData } from "#src/backend/lib/utils/redact";

/**
 * Writes the verdict and answers what the store made of it. A store failure is
 * logged and fails the enclosing durable step, so the executor retries the
 * step. `output` is redacted here, before it reaches the store.
 *
 * A Cancel claim that refused the verdict answers `cancel_claimed` with
 * nothing written, so the caller runs the Canceled outlet for that claim and
 * then records `canceled`.
 */
export const recordVerdict = Effect.fnUntraced(function* (input: {
  store: WorkflowStore;
  executionId: string;
  verdict: RunVerdict;
  output?: unknown;
}): Effect.fn.Return<RunEndAnswer, StoreFailure> {
  const { verdict } = input;
  const answer = yield* input.store
    .completeRun({
      executionId: input.executionId,
      verdict,
      output: redactSensitiveData(input.output),
    })
    .pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Terminal run record not written").pipe(
          Effect.annotateLogs({
            run: { execution: input.executionId },
            outcome: { verdict: verdict.status },
            error,
          })
        )
      )
    );
  if (answer.kind !== "ended") {
    yield* Effect.logInfo(
      answer.kind === "cancel_claimed"
        ? "A Cancel claim refused the terminal record; the Canceled outlet runs next"
        : "Run did not claim the terminal record"
    ).pipe(
      Effect.annotateLogs({
        outcome: { verdict: verdict.status, left: answer.kind },
      })
    );
  }
  return answer;
});
