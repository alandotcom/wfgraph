/**
 * Every action node: Wait, Condition, Event Split, and plugin/host actions.
 *
 * Template resolution and the step context are shared; the action id picks the
 * work. Wait may hand off to a durable branch via the context the scheduler
 * fills in.
 */

import { runConditionStep } from "#src/backend/engine/strategies/condition";
import { runEventSplitStep } from "#src/backend/engine/strategies/event-split";
import { runPluginActionStep } from "#src/backend/engine/strategies/plugin-action";
import type {
  ActionStepInput,
  NodeStrategy,
  NodeWorkContext,
  NodeWorkOutcome,
} from "#src/backend/engine/strategies/types";
import type { NodeContext } from "#src/backend/engine/step-log";
import {
  processTemplates,
  resolveTemplateString,
} from "#src/backend/engine/templates";
import { executeWaitAction } from "#src/backend/engine/wait";
import { BUILT_IN_ACTION_IDS } from "@rova/shared/actions/built-in-actions";
import { actionTypeOf, readConfigString } from "@rova/shared/graph/node-config";
import { Effect } from "effect";
import { failedExecution } from "#src/backend/engine/contracts";
import {
  type EngineFailure,
  engineFailure,
} from "#src/backend/engine/engine-failure";

function getNodeName(
  node: NodeWorkContext["node"],
  actions: NodeWorkContext["actions"]
): string {
  if (node.data.label) {
    return node.data.label;
  }
  const actionType = actionTypeOf(node);
  if (actionType) {
    const label = actions.metadataFor(actionType)?.label;
    if (label) {
      return label;
    }
  }
  return "Action";
}

function executeActionStep(
  input: ActionStepInput
): Effect.Effect<
  { result: NodeWorkOutcome["result"]; conditionValue?: boolean },
  EngineFailure
> {
  const execute = Effect.suspend(() => {
    if (input.actionType === BUILT_IN_ACTION_IDS.condition) {
      return runConditionStep(input);
    }
    if (input.actionType === BUILT_IN_ACTION_IDS.eventSplit) {
      return runEventSplitStep(input);
    }
    return runPluginActionStep(input);
  });

  return execute.pipe(
    Effect.withSpan("rova.workflow.action.execute", {
      attributes: {
        "rova.action.type": input.actionType,
        "rova.node.id": input.context.nodeId,
        "rova.node.name": input.context.nodeName,
      },
    })
  );
}

function runAction(ctx: NodeWorkContext) {
  const config = ctx.node.data.config || {};
  const actionType = readConfigString(config, "actionType");

  return Effect.gen(function* () {
    const {
      node,
      traversal,
      runtime,
      store,
      actions,
      executionId,
      workflowId,
      workflowRunId,
      runMode,
    } = ctx;

    yield* Effect.logDebug("Executing action node");

    if (!actionType) {
      yield* Effect.logError("Action node missing action type");
      return {
        result: failedExecution(
          engineFailure(
            "failure",
            `Action node "${node.data.label || node.id}" has no action type configured`
          )
        ),
        unconfigured: true,
      };
    }

    // The Condition node's expression is held out of template resolution and
    // put back. It cannot say so with a `literal` field the way every other
    // action does, because `built-ins.ts` gives Condition no config fields at
    // all: the editor draws it with a bespoke panel. The key is deleted rather
    // than emptied, because a config key present and holding `undefined` fails
    // a step's config decode.
    const { condition: originalCondition, ...configWithoutCondition } = config;

    const processedConfig = processTemplates(
      configWithoutCondition,
      traversal.outputs,
      new Set(actions.metadataFor(actionType)?.literalConfigKeys ?? [])
    );

    if (originalCondition !== undefined) {
      processedConfig.condition = originalCondition;
    }

    const stepContext: NodeContext = {
      executionId,
      nodeId: node.id,
      nodeName: getNodeName(node, actions),
      nodeType: actionType,
      runMode,
    };
    yield* Effect.logDebug("Calling executeActionStep");

    if (actionType === BUILT_IN_ACTION_IDS.wait) {
      if (!ctx.entersInPlace) {
        return yield* ctx.handOffBranch();
      }

      const waitOutcome = yield* executeWaitAction({
        config: processedConfig,
        context: stepContext,
        runtime,
        store,
        workflowId,
        workflowRunId,
        resolveTemplates: (value) =>
          resolveTemplateString(value, traversal.outputs),
      });

      const waitResult = waitOutcome.result;
      if (waitResult.success) {
        return {
          result: { success: true as const, data: waitResult },
          haltBranch: waitOutcome.haltBranch,
        };
      }

      yield* Effect.logError("Wait failed").pipe(
        Effect.annotateLogs({
          nodeId: node.id,
          nodeLabel: node.data.label,
          error: waitResult.error.message,
        })
      );
      return { result: waitResult };
    }

    const actionOutcome = yield* executeActionStep({
      actionType,
      config: processedConfig,
      outputs: traversal.outputs,
      context: stepContext,
      runtime,
      store,
      actions,
      eventName: ctx.eventName,
      catalogFingerprint: ctx.catalogFingerprint,
    });

    const stepResult = actionOutcome.result;
    if (stepResult.success) {
      return {
        result: { success: true as const, data: stepResult },
        conditionValue: actionOutcome.conditionValue,
      };
    }

    yield* Effect.logError("Action step failed").pipe(
      Effect.annotateLogs({
        actionType,
        nodeId: node.id,
        nodeLabel: node.data.label,
        error: stepResult.error.message,
      })
    );
    return {
      result: stepResult,
      conditionValue: actionOutcome.conditionValue,
    };
  }).pipe(Effect.annotateLogs({ actionType: actionType ?? null }));
}

export const actionStrategy: NodeStrategy = {
  id: "action",
  run: runAction,
};
