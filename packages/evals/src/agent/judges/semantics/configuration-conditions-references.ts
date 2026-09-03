import { findAction } from "@wfgraph/shared/extensions/catalog";
import { enabledActionTypeOf } from "@wfgraph/shared/graph/node-config";
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { parseConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import { readWaitSubscriptions } from "@wfgraph/shared/lifecycle/wait-subscription";
import { isBlank } from "@wfgraph/shared/types/string";
import { parseDurationMs } from "@wfgraph/shared/utils/wait-time";
import {
  checkEach,
  matchesSelector,
  nodesMatching,
  nodesSatisfy,
  selectorName,
  type SemanticsContext,
} from "#src/agent/judges/semantics/context";

function missingConfigs(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredConfigs, (required) => {
    const hasConfig = (node: WorkflowNode) =>
      Object.entries(required.values).every(
        ([key, value]) => node.data.config?.[key] === value
      );
    return nodesSatisfy(context, required, hasConfig)
      ? undefined
      : `${selectorName(required.node)} does not have required config ${Object.keys(required.values).join(", ")}`;
  });
}

function presentForbiddenConfigs(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.forbiddenConfigKeys, (required) => {
    const omitsConfigs = (node: WorkflowNode) =>
      required.keys.every((key) => node.data.config?.[key] === undefined);
    return nodesSatisfy(context, required, omitsConfigs)
      ? undefined
      : `${selectorName(required.node)} has forbidden config ${required.keys.join(", ")}`;
  });
}

function emptyConfigs(context: SemanticsContext): string[] {
  return checkEach(
    context.input.expected.requiredNonEmptyConfigs,
    (required) => {
      const hasNonEmptyConfig = (node: WorkflowNode) =>
        required.keys.every((key) => {
          const value = node.data.config?.[key];
          return typeof value === "string"
            ? !isBlank(value)
            : value !== undefined && value !== null;
        });
      return nodesSatisfy(context, required, hasNonEmptyConfig)
        ? undefined
        : `${selectorName(required.node)} has empty required config ${required.keys.join(", ")}`;
    }
  );
}

function missingDurations(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredDurations, (required) => {
    const expectedMs = parseDurationMs(required.duration);
    const satisfied = nodesMatching(context, required.node).some(
      (node) =>
        expectedMs !== null &&
        parseDurationMs(node.data.config?.[required.key]) === expectedMs
    );
    return satisfied
      ? undefined
      : `${selectorName(required.node)} does not have required duration ${required.key}`;
  });
}

function missingWaitEvents(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredWaitEvents, (required) => {
    const subscribed = new Set(
      nodesMatching(context, required.node)
        .flatMap((node) => readWaitSubscriptions(node.data.config))
        .map((subscription) => subscription.event)
    );
    const missing = required.events.filter((event) => !subscribed.has(event));
    if (missing.length > 0) {
      return `${selectorName(required.node)} is missing required Wait Event ${missing.join(", ")}`;
    }
    return required.exact && subscribed.size !== required.events.length
      ? `${selectorName(required.node)} has unexpected Wait Event subscriptions`
      : undefined;
  });
}

function missingConditionRules(context: SemanticsContext): string[] {
  return checkEach(
    context.input.expected.requiredConditionRules,
    (required) => {
      const found = nodesMatching(context, required.node).some((node) => {
        const parsed = parseConditionModel(node.data.config?.conditionModel);
        if (!parsed.valid) {
          return false;
        }
        return parsed.model.groups.some((group) =>
          group.conditions.some(
            (rule) =>
              rule.field === required.field &&
              rule.operator === required.operator &&
              (required.value === undefined ||
                ("value" in rule && rule.value === required.value))
          )
        );
      });
      return found
        ? undefined
        : `${selectorName(required.node)} is missing required rule ${required.field} ${required.operator}${required.value === undefined ? "" : ` ${required.value}`}`;
    }
  );
}

function wrongConditionLogic(context: SemanticsContext): string[] {
  return checkEach(
    context.input.expected.requiredConditionLogic,
    (required) => {
      const found = nodesMatching(context, required.node).some((node) => {
        const parsed = parseConditionModel(node.data.config?.conditionModel);
        return (
          parsed.valid &&
          parsed.model.groupLogic === required.groupLogic &&
          (required.ruleLogic === undefined ||
            parsed.model.groups.every(
              (group) => group.logic === required.ruleLogic
            ))
        );
      });
      return found
        ? undefined
        : `${selectorName(required.node)} does not use required ${required.groupLogic}/${required.ruleLogic ?? "any"} logic`;
    }
  );
}

function missingReferences(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredReferences, (required) => {
    const hasReference = (node: WorkflowNode) => {
      const value = node.data.config?.[required.key];
      if (typeof value !== "string") {
        return false;
      }
      return findTemplateTokens(value).some((token) => {
        if (token.fieldPath !== required.path) {
          return false;
        }
        const source = context.nodeById.get(token.nodeId);
        if (matchesSelector(source, { kind: "lifecycle" })) {
          return context.input.catalog.events.some((event) =>
            event.payloadFields.some((field) => field.path === required.path)
          );
        }
        const sourceAction = source ? enabledActionTypeOf(source) : undefined;
        return (
          sourceAction !== undefined &&
          findAction(context.input.catalog, sourceAction)?.outputFields.some(
            (field) => field.path === required.path
          ) === true
        );
      });
    };
    return nodesSatisfy(context, required, hasReference)
      ? undefined
      : `${selectorName(required.node)} ${required.key} does not reference ${required.path}`;
  });
}

function wrongDistinctConfigValues(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.distinctConfigValues, (required) => {
    const values = new Set(
      nodesMatching(context, required.nodes)
        .map((node) => node.data.config?.[required.key])
        .filter(
          (value): value is string | number | boolean =>
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
        )
    );
    return values.size === required.count
      ? undefined
      : `${selectorName(required.nodes)} needs ${required.count} distinct ${required.key} values, found ${values.size}`;
  });
}

/** Runs configuration, condition, Wait, and reference rules in rationale order. */
export function assessConfigurationSemantics(
  context: SemanticsContext
): string[] {
  return [
    ...missingConfigs(context),
    ...presentForbiddenConfigs(context),
    ...emptyConfigs(context),
    ...missingDurations(context),
    ...missingWaitEvents(context),
    ...missingConditionRules(context),
    ...wrongConditionLogic(context),
    ...missingReferences(context),
    ...wrongDistinctConfigValues(context),
  ];
}
