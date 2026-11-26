/**
 * A workflow's tracked Entity and the positive condition guarding its lifetime.
 *
 * Event bindings establish identity. The condition reads only current Entity
 * State, and checkpoints decide whether the read happens before admission,
 * before Started-side nodes, or at both boundaries.
 */

import { Schema } from "effect";
import {
  compileConditionModel,
  type ConditionModel,
  isNullCheckConditionRule,
  isStringSetConditionRule,
  parseConditionModel,
  readConditionRuleOperands,
} from "#src/conditions/conditions";
import {
  conditionTypeOf,
  findConditionFieldDeclaration,
} from "#src/conditions/condition-field-type";
import {
  type EntityMetadata,
  type EventEntityBindingMetadata,
  type ExtensionCatalog,
  findEntity,
  findEvent,
} from "#src/extensions/catalog";
import { findTemplateTokens } from "#src/graph/node-references";
import type {
  LifecycleRules,
  LifecycleRulesCheck,
} from "#src/lifecycle/lifecycle-rules";
import { NonEmptyTrimmedString } from "#src/types/schema";

export const entityEligibilityCheckpointSchema = Schema.Literals([
  "before-execution",
  "before-node",
]);

export const trackedEntitySchema = Schema.Struct({
  type: NonEmptyTrimmedString,
  bindings: Schema.Record(Schema.String, NonEmptyTrimmedString),
});

export const entityEligibilitySchema = Schema.Struct({
  condition: Schema.String,
  checkpoints: Schema.Array(entityEligibilityCheckpointSchema),
});

/** The current-state source a Lifecycle's tracked Entity makes available. */
export function findTrackedEntityStateSource(input: {
  rules: LifecycleRules | undefined;
  catalog: ExtensionCatalog;
}): EntityMetadata | undefined {
  const tracked = input.rules?.trackedEntity;
  return tracked ? findEntity(input.catalog, tracked.type) : undefined;
}

const valid: LifecycleRulesCheck = { valid: true };

function refuse(error: string): LifecycleRulesCheck {
  return { valid: false, error };
}

// Built here rather than imported: `lifecycle-rules.ts` reads this module's
// schemas, so a value import back from it would be a cycle.
function refuseUnfinished(error: string): LifecycleRulesCheck {
  return { valid: false, error, unfinished: true };
}

function lifecycleEventNames(rules: LifecycleRules): string[] {
  return [...rules.startEvents, ...rules.cancelEvents];
}

/**
 * The bindings the Event `eventName` declares that identify an Entity of
 * `entityType`, in the order the Event declares them. Empty for an Event the
 * catalog no longer declares.
 */
export function entityBindingChoices(input: {
  catalog: ExtensionCatalog;
  eventName: string;
  entityType: string;
}): readonly EventEntityBindingMetadata[] {
  return (
    findEvent(input.catalog, input.eventName)?.entityBindings ?? []
  ).filter((binding) => binding.entityType === input.entityType);
}

/**
 * `rules` with one binding of the tracked Entity for each Start and Cancel
 * Event that can provide one: the binding already chosen while the Event still
 * declares it, and otherwise the Event's first compatible binding. A binding
 * for an Event the rules no longer name is dropped, and an Event with no
 * compatible binding keeps none, which `checkEntityEligibility` refuses.
 * Rules that track no Entity are returned as they are.
 */
export function reconcileEntityBindings(
  rules: LifecycleRules,
  catalog: ExtensionCatalog
): LifecycleRules {
  const tracked = rules.trackedEntity;
  if (!tracked) {
    return rules;
  }
  const bindings = Object.fromEntries(
    lifecycleEventNames(rules).flatMap((eventName) => {
      const choices = entityBindingChoices({
        catalog,
        eventName,
        entityType: tracked.type,
      });
      const selected = choices.some(
        (choice) => choice.name === tracked.bindings[eventName]
      )
        ? tracked.bindings[eventName]
        : choices[0]?.name;
      return selected ? [[eventName, selected]] : [];
    })
  );
  return { ...rules, trackedEntity: { type: tracked.type, bindings } };
}

function unreadableEligibilityRule(
  entity: EntityMetadata,
  model: ConditionModel
): string | undefined {
  for (const group of model.groups) {
    for (const rule of group.conditions) {
      const path = rule.field.trim();
      const declaration = findConditionFieldDeclaration(
        entity.stateFields,
        rule
      );
      if (!declaration) {
        return `reads "${path}", which Entity "${entity.type}" does not declare`;
      }

      if (isNullCheckConditionRule(rule) && !declaration.nullable) {
        return `checks whether "${path}" is set, but Entity "${entity.type}" now requires that field`;
      }

      const offered = conditionTypeOf(declaration.field);
      if (offered === null) {
        return `compares "${path}", which Entity "${entity.type}" declares as a shape no rule can compare`;
      }
      if (offered !== rule.fieldType) {
        return `compares "${path}" as ${rule.fieldType}, which Entity "${entity.type}" now declares as ${offered}`;
      }
      const hasTemplateOperand = readConditionRuleOperands(rule).some(
        (operand) => findTemplateTokens(operand).length > 0
      );
      if (hasTemplateOperand) {
        return `compares "${path}" against a value from the run, but Entity Eligibility accepts literal values only`;
      }
      if (
        isStringSetConditionRule(rule) &&
        (!declaration.field.enumValues ||
          declaration.field.enumValues.length === 0)
      ) {
        return `uses a set comparison for "${path}", which Entity "${entity.type}" no longer offers as a fixed list`;
      }
      if (
        !isNullCheckConditionRule(rule) &&
        rule.fieldType === "string" &&
        rule.operator !== "contains" &&
        declaration.field.enumValues &&
        declaration.field.enumValues.length > 0
      ) {
        const values = isStringSetConditionRule(rule)
          ? rule.values
          : [rule.value];
        const unavailable = values.find(
          (value) => !declaration.field.enumValues?.includes(value)
        );
        if (unavailable !== undefined) {
          return `compares "${path}" with "${unavailable}", which Entity "${entity.type}" no longer offers`;
        }
      }
    }
  }

  return undefined;
}

export function checkEntityEligibilityCondition(
  entity: EntityMetadata,
  serialized: string
): LifecycleRulesCheck {
  const parsed = parseConditionModel(serialized);
  if (!parsed.valid) {
    return refuse(`Entity Eligibility is invalid: ${parsed.error}`);
  }

  const compiled = compileConditionModel(parsed.model);
  if (!compiled.valid) {
    return compiled.incomplete
      ? refuseUnfinished(
          "Entity Eligibility is unfinished. Complete it before publishing."
        )
      : refuse(`Entity Eligibility is invalid: ${compiled.error}`);
  }

  const unreadable = unreadableEligibilityRule(entity, parsed.model);
  return unreadable
    ? refuse(
        `Entity Eligibility ${unreadable}. Rebuild the condition against the current Entity State schema.`
      )
    : valid;
}

/**
 * Holds a tracked workflow to one available Entity type and one compatible
 * binding per lifecycle Event. When eligibility is configured, its condition
 * must be complete and its checkpoint set non-empty.
 */
export function checkEntityEligibility(input: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
}): LifecycleRulesCheck {
  const { rules, catalog } = input;
  const tracked = rules.trackedEntity;
  const eligibility = rules.entityEligibility;

  if (!tracked && !eligibility) {
    return valid;
  }
  if (!tracked) {
    return refuse(
      "Entity Eligibility has no tracked Entity. Choose the Entity this workflow tracks."
    );
  }
  const entity = findEntity(catalog, tracked.type);
  if (!entity) {
    return refuse(
      `No Entity type "${tracked.type}" is available. Choose an Entity this app declares, or ask the host to restore it.`
    );
  }

  if (rules.startEvents.length === 0) {
    return refuse(
      "Tracking an Entity needs a Start Event to establish identity. Add a Start Event with a compatible binding."
    );
  }

  const names = lifecycleEventNames(rules);
  const named = new Set(names);
  const strayBinding = Object.keys(tracked.bindings).find(
    (eventName) => !named.has(eventName)
  );
  if (strayBinding) {
    return refuse(
      `Tracked Entity binding for Event "${strayBinding}" is neither a start nor a Cancel Event. Remove that binding or add the Event as a Start or Cancel Event.`
    );
  }

  for (const eventName of names) {
    const bindingName = tracked.bindings[eventName];
    if (!bindingName) {
      return refuse(
        `Event "${eventName}" has no selected Entity binding. Choose a binding to Entity "${tracked.type}".`
      );
    }

    const event = findEvent(catalog, eventName);
    const binding = event?.entityBindings?.find(
      (candidate) => candidate.name === bindingName
    );
    if (!binding) {
      return refuse(
        `Event "${eventName}" has no Entity binding named "${bindingName}". Choose one of the bindings that Event declares.`
      );
    }
    if (binding.entityType !== tracked.type) {
      return refuse(
        `Event "${eventName}" binding "${bindingName}" identifies Entity "${binding.entityType}", not tracked Entity "${tracked.type}". Choose compatible bindings for every start and Cancel Event.`
      );
    }
    if (rules.correlationPaths?.[eventName]) {
      return refuse(
        `Event "${eventName}" cannot use a Correlation Path while this workflow tracks an Entity. Remove the Correlation Path; the selected Entity binding supplies identity.`
      );
    }
  }

  if (!eligibility) {
    return valid;
  }

  if (eligibility.checkpoints.length === 0) {
    return refuse(
      "Entity Eligibility has no checkpoint. Select Before opening an Execution, Before each workflow node, or both."
    );
  }
  if (
    new Set(eligibility.checkpoints).size !== eligibility.checkpoints.length
  ) {
    return refuse(
      "Entity Eligibility checkpoints must not contain duplicates."
    );
  }

  return checkEntityEligibilityCondition(entity, eligibility.condition);
}
