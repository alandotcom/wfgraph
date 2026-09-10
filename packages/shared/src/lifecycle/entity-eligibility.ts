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
  type ConditionRule,
  isNullCheckConditionRule,
  parseConditionModel,
  readConditionRuleOperand,
} from "#src/conditions/conditions";
import { conditionTypeOf } from "#src/conditions/condition-field-type";
import {
  type EntityMetadata,
  type ExtensionCatalog,
  findEntity,
  findEvent,
} from "#src/extensions/catalog";
import {
  appendOutputPathKey,
  findTemplateTokens,
} from "#src/graph/node-references";
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

const valid: LifecycleRulesCheck = { valid: true };

function refuse(error: string): LifecycleRulesCheck {
  return { valid: false, error };
}

function lifecycleEventNames(rules: LifecycleRules): string[] {
  return [...rules.startEvents, ...rules.cancelEvents];
}

function keyUnder(recordPath: string, path: string): boolean {
  if (!path.startsWith(`${recordPath}.`)) {
    return false;
  }

  const rest = path.slice(recordPath.length + 1);
  return rest.length > 0 && !rest.includes(".");
}

type EligibilityFieldDeclaration = {
  field: EntityMetadata["stateFields"][number];
  nullable: boolean;
};

function declarationForRule(
  entity: EntityMetadata,
  rule: ConditionRule
): EligibilityFieldDeclaration | undefined {
  const path = rule.field.trim();
  const key = rule.recordKey?.trim();
  const byPath = new Map(
    entity.stateFields.map((field) => [field.path, field])
  );
  const openRecords = entity.stateFields.filter((field) => field.valueType);

  if (key) {
    const base = byPath.get(path);
    if (base?.valueType) {
      return { field: base, nullable: true };
    }

    const field = byPath.get(appendOutputPathKey(path, key));
    return field ? { field, nullable: field.nullable === true } : undefined;
  }

  const exact = byPath.get(path);
  if (exact) {
    return { field: exact, nullable: exact.nullable === true };
  }

  const openRecord = openRecords.find((field) => keyUnder(field.path, path));
  return openRecord ? { field: openRecord, nullable: true } : undefined;
}

function unreadableEligibilityRule(
  entity: EntityMetadata,
  model: ConditionModel
): string | undefined {
  for (const group of model.groups) {
    for (const rule of group.conditions) {
      const path = rule.field.trim();
      const declaration = declarationForRule(entity, rule);
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
      const operand = readConditionRuleOperand(rule);
      if (operand && findTemplateTokens(operand).length > 0) {
        return `compares "${path}" against a value from the run, but Entity Eligibility accepts literal values only`;
      }
      if (
        !isNullCheckConditionRule(rule) &&
        rule.fieldType === "string" &&
        (rule.operator === "equals" || rule.operator === "not_equals") &&
        declaration.field.enumValues &&
        declaration.field.enumValues.length > 0 &&
        !declaration.field.enumValues.includes(rule.value)
      ) {
        return `compares "${path}" with "${rule.value}", which Entity "${entity.type}" no longer offers`;
      }
    }
  }

  return undefined;
}

function checkEligibilityCondition(
  entity: EntityMetadata,
  serialized: string
): LifecycleRulesCheck {
  const parsed = parseConditionModel(serialized);
  if (!parsed.valid) {
    return refuse(`Entity Eligibility is invalid: ${parsed.error}`);
  }

  const compiled = compileConditionModel(parsed.model);
  if (!compiled.valid) {
    return refuse(
      compiled.incomplete
        ? "Entity Eligibility is unfinished. Complete it before publishing."
        : `Entity Eligibility is invalid: ${compiled.error}`
    );
  }

  const unreadable = unreadableEligibilityRule(entity, parsed.model);
  return unreadable
    ? refuse(
        `Entity Eligibility ${unreadable}. Rebuild the condition against the current Entity State schema.`
      )
    : valid;
}

/**
 * Holds a guarded workflow to one available Entity type, one compatible binding
 * per lifecycle Event, one complete condition, and a non-empty checkpoint set.
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
  if (!eligibility) {
    return refuse(
      `Tracked Entity "${tracked.type}" has no Eligibility condition. Add Entity Eligibility, or remove the tracked Entity.`
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
      "Entity Eligibility needs a Start Event to establish Entity identity. Add a Start Event with a compatible binding."
    );
  }

  const names = lifecycleEventNames(rules);
  const named = new Set(names);
  const strayBinding = Object.keys(tracked.bindings).find(
    (eventName) => !named.has(eventName)
  );
  if (strayBinding) {
    return refuse(
      `Tracked Entity binding for Event "${strayBinding}" has no lifecycle role. Remove that binding or add the Event as a Start or Cancel Event.`
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
        `Event "${eventName}" binding "${bindingName}" identifies Entity "${binding.entityType}", not tracked Entity "${tracked.type}". Choose compatible bindings for every lifecycle Event.`
      );
    }
    if (rules.correlationPaths?.[eventName]) {
      return refuse(
        `Event "${eventName}" cannot use a Correlation Path while this workflow tracks an Entity. Remove the Correlation Path; the selected Entity binding supplies identity.`
      );
    }
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

  return checkEligibilityCondition(entity, eligibility.condition);
}
