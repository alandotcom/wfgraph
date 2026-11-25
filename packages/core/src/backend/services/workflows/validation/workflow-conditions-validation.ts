import { checkCelBooleanExpression } from "#src/backend/lib/cel/environment";
import {
  compileConditionModel,
  compileSerializedConditionModel,
  parseConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { readWaitSubscriptions } from "@wfgraph/shared/lifecycle/wait-subscription";
import {
  type StepNames,
  unnumberedStepNames,
} from "#src/backend/services/workflows/validation/step-names";

export type WorkflowConditionsValidationResult =
  | { valid: true }
  | { valid: false; error: string };

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Every Wait Subscription's match, held to the same bar a Condition node's is.
 *
 * The match compiles at park time rather than at save, so without this a model
 * the builder never finished would be found by a run that had already started
 * and had nowhere to go. There is no stored expression to compare against here:
 * the wait keeps the model alone, because half of what it compares is a value
 * only the run knows.
 *
 * A match whose operands are still blank is skipped, the same carve-out the
 * Condition node's empty expression gets: "Add a match" seeds a rule with an
 * empty value, and refusing that would refuse every autosave until the builder
 * typed one. Running is what requires it -- the action-config pass reports the
 * node as missing a required field, in preflight and in the editor alike.
 */
function validateWaitMatches(
  node: WorkflowNode,
  config: Record<string, unknown>,
  names: StepNames
): WorkflowConditionsValidationResult {
  for (const subscription of readWaitSubscriptions(config)) {
    const match = asNonEmptyString(subscription.match);
    if (!match) {
      continue;
    }

    const compiled = compileSerializedConditionModel(match);
    if (!compiled.valid && !compiled.incomplete) {
      return {
        valid: false,
        error: `${names.of(node)} has a match for "${subscription.event}" that cannot be read: ${compiled.error}`,
      };
    }
  }

  return { valid: true };
}

/**
 * A Condition's stored expression, held to the rules it was built from. The
 * model's own errors name what is wrong with a rule and never quote its
 * value. The CEL check's error can quote the expression, which holds the
 * values the person typed, so that sentence stops at the step.
 */
function validateCompiledExpression(input: {
  node: WorkflowNode;
  expression: string;
  modelRaw: unknown;
  names: StepNames;
}): WorkflowConditionsValidationResult {
  const step = input.names.of(input.node);
  const parsedModel = parseConditionModel(input.modelRaw);
  if (!parsedModel.valid) {
    return {
      valid: false,
      error: `${step} has condition rules that cannot be read: ${parsedModel.error}`,
    };
  }

  const compiled = compileConditionModel(parsedModel.model);
  if (!compiled.valid) {
    return {
      valid: false,
      error: `${step} has condition rules that cannot be read: ${compiled.error}`,
    };
  }

  if (compiled.expression !== input.expression) {
    return {
      valid: false,
      error: `${step} has a condition that no longer matches its rules. Open the step and save its rules again.`,
    };
  }

  const celValidation = checkCelBooleanExpression(input.expression);
  if (!celValidation.ok) {
    return {
      valid: false,
      error: `${step} has a condition the engine cannot evaluate`,
    };
  }

  return { valid: true };
}

/**
 * Every Condition's rules and every Wait's matches. `names` numbers the steps
 * in the messages; without it a step is named by its label alone.
 */
export function validateWorkflowConditionConfigs(
  nodes: WorkflowNode[],
  names: StepNames = unnumberedStepNames()
): WorkflowConditionsValidationResult {
  for (const node of nodes) {
    if (node.data.type !== "action") {
      continue;
    }

    const config = node.data.config;
    if (!config || typeof config !== "object") {
      continue;
    }

    const actionType =
      typeof config.actionType === "string" ? config.actionType : "";

    if (actionType === BUILT_IN_ACTION_IDS.condition) {
      // The builder writes an empty expression while a rule is still incomplete,
      // so an empty one marks a node the user is mid-way through rather than a
      // broken one. Running is what requires it: preflight's action-config pass
      // reports the node as missing a required field, and the editor shows the
      // same issue and blocks Run.
      const conditionExpression = asNonEmptyString(config.condition);
      if (!conditionExpression) {
        continue;
      }

      const conditionModel = asNonEmptyString(config.conditionModel);
      if (!conditionModel) {
        return {
          valid: false,
          error: `${names.of(node)} has a condition written outside the rule builder. Build it with the rule builder.`,
        };
      }

      const conditionValidation = validateCompiledExpression({
        node,
        expression: conditionExpression,
        modelRaw: conditionModel,
        names,
      });
      if (!conditionValidation.valid) {
        return conditionValidation;
      }
    }

    if (actionType === BUILT_IN_ACTION_IDS.wait) {
      const matchValidation = validateWaitMatches(node, config, names);
      if (!matchValidation.valid) {
        return matchValidation;
      }
    }
  }

  return { valid: true };
}
