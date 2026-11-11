/**
 * The Event Split node: routes by the Arriving Event its branch carries,
 * decided once as a durable step under `node:<id>:route` and read back from
 * that memo on every later pass, so a replay leaves by the outlet the first
 * pass chose.
 */

import { runDurable } from "#src/backend/engine/durable";
import { runWithStepLog } from "#src/backend/engine/step-log";
import type { ActionStepInput } from "#src/backend/engine/strategies/types";
import { executionResultFromStepResult } from "#src/backend/engine/contracts";
import { Effect } from "effect";

export function runEventSplitStep(input: ActionStepInput) {
  return Effect.gen(function* () {
    const { context, store, runtime } = input;

    const { event } = yield* runDurable(
      runtime,
      {
        id: `node:${context.nodeId}:route`,
        nodeId: context.nodeId,
        name: `${context.nodeName} (route)`,
      },
      Effect.sync(() => ({ event: input.eventName }))
    );

    const result = yield* runWithStepLog(
      { store, context, runtime, input: { event } },
      () => Effect.succeed({ success: true as const, data: { event } })
    );

    return {
      result: executionResultFromStepResult(result),
      routedEvent: event,
    };
  });
}
