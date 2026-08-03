/**
 * The Wait node: the one action the engine runs itself and the one node it never
 * wraps in a step.
 *
 * Inngest forbids a sleep or an event wait inside a step, so this module
 * memoizes its own persistence segments around those boundaries instead: the
 * config read and the row that opens, the preparation that parks the run, and
 * the resume that closes the row. `executeWaitAction` is the whole of what the
 * traversal calls. Delay and event branches live beside this file.
 */

import { Effect } from "effect";
import { readWaitConfig } from "@rova/shared/lifecycle/wait-subscription";
import { closeStepLog, openStepLog } from "#src/backend/engine/step-log";
import { runDurable } from "#src/backend/engine/durable";
import type { EngineFailure } from "#src/backend/engine/engine-failure";
import { executeDelayWait } from "#src/backend/engine/wait-delay";
import { executeEventWait } from "#src/backend/engine/wait-event";
import {
  readAllowedHoursConfig,
  readWaitGateMode,
  type WaitActionInput,
  type WaitBranchContext,
  type WaitOutcome,
} from "#src/backend/engine/wait-shared";

export type {
  WaitActionInput,
  WaitOutcome,
} from "#src/backend/engine/wait-shared";

export function executeWaitAction(
  input: WaitActionInput
): Effect.Effect<WaitOutcome, EngineFailure> {
  const waitType = input.config.waitMode === "event" ? "event" : "delay";
  const execute = executeWaitActionInner(input);

  return execute.pipe(
    Effect.withSpan("rova.workflow.wait", {
      attributes: {
        "rova.wait.type": waitType,
        "rova.node.id": input.context.nodeId,
        "rova.node.name": input.context.nodeName,
      },
    })
  );
}

function executeWaitActionInner(
  input: WaitActionInput
): Effect.Effect<WaitOutcome, EngineFailure> {
  return Effect.gen(function* () {
    const {
      context,
      runtime,
      store,
      workflowId,
      workflowRunId,
      resolveTemplates,
    } = input;

    const runId = workflowRunId || runtime.runId || context.executionId;

    // The first schema this node has ever had, so a config written against the
    // retired shape stops the run here rather than parking on a wait nothing can
    // reach. Both log rows are one durable unit, so a replay does not duplicate.
    const read = readWaitConfig(input.config);
    if (!read.valid) {
      const errorMessage = `Wait node configuration is invalid: ${read.error}`;
      yield* runDurable(
        runtime,
        `wait-invalid-config-${context.nodeId}`,
        Effect.gen(function* () {
          const earlyLog = yield* openStepLog({
            store,
            context,
            input: {},
          });
          yield* closeStepLog(store, earlyLog, {
            status: "error",
            error: errorMessage,
          });
          return { logged: true };
        })
      );

      return {
        result: {
          success: false,
          error: { kind: "failure", message: errorMessage },
        },
        haltBranch: false,
      };
    }

    const config = read.config;

    // The "step started" row is written once and its id is replayed from the
    // memoized step return, so the branches below always close the same row.
    const startLog = yield* runDurable(
      runtime,
      `wait-start-log-${context.nodeId}`,
      openStepLog({
        store,
        context,
        input: {
          waitMode: read.waitMode,
          waitDuration: config.waitDuration,
          waitUntil: config.waitUntil,
          waitOffset: config.waitOffset,
          waitTimezone: config.waitTimezone,
          waitGateMode: readWaitGateMode(config),
          ...readAllowedHoursConfig(config),
          waitFor: config.waitFor?.map((subscription) => subscription.event),
          waitTimeout: config.waitTimeout,
        },
      })
    );

    const branch: WaitBranchContext = {
      config,
      context,
      runtime,
      store,
      workflowId,
      runId,
      resolveTemplates,
      startLog,
    };

    if (read.waitMode === "delay") {
      return yield* executeDelayWait(branch);
    }
    return yield* executeEventWait(branch);
  });
}
