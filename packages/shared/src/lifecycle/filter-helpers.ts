/**
 * Role-neutral helpers for the per-Event Start Filter and Cancel Filter APIs.
 *
 * The two lifecycle roles validate the same serialized condition model and use
 * the same layout and persistence rules. Their public modules supply the role
 * names so error messages explain whether a run starts or is canceled.
 */

import { isEmptyObject } from "es-toolkit/predicate";
import {
  compileConditionModel,
  compileSerializedConditionModel,
  type ConditionModel,
  EVENT_NAME_FIELD_PATH,
  isNullCheckConditionRule,
  parseConditionModel,
  readConditionRuleOperands,
} from "#src/conditions/conditions";
import {
  conditionTypeOf,
  findConditionFieldDeclaration,
} from "#src/conditions/condition-field-type";
import { type ExtensionCatalog, findEvent } from "#src/extensions/catalog";
import { findTemplateTokens } from "#src/graph/node-references";
import type {
  LifecycleRules,
  LifecycleRulesCheck,
} from "#src/lifecycle/lifecycle-rules";
import {
  lifecycleRulesValid,
  refuseLifecycleRules,
  refuseUnfinishedLifecycleRules,
  retainNamedKeys,
} from "#src/lifecycle/lifecycle-rules";

export type FilterRole = "start" | "cancel";

export type FilterLayout =
  | { collapsed: true; model?: string }
  | { collapsed: false };

type FilterModels =
  | { valid: true; models: [string, ConditionModel][] }
  | { valid: false; error: string };

function roleLabel(role: FilterRole): string {
  return `${role} filter`;
}

/**
 * The name each filter goes by in the Start's form, which is how its Publish
 * refusals name it.
 */
export const FILTER_RULE_NAMES = {
  start: "Only start when",
  cancel: "Only stop when",
} as const satisfies Record<FilterRole, string>;

function eventNames(
  rules: LifecycleRules,
  role: FilterRole
): readonly string[] {
  return role === "start" ? rules.startEvents : rules.cancelEvents;
}

function filters(
  rules: LifecycleRules,
  role: FilterRole
): Record<string, string> | undefined {
  return role === "start" ? rules.startFilters : rules.cancelFilters;
}

export function readFilter(
  rules: LifecycleRules,
  role: FilterRole,
  eventName: string
): string | undefined {
  const stored = filters(rules, role);
  if (!stored || !Object.hasOwn(stored, eventName)) {
    return undefined;
  }

  return stored[eventName]?.trim() || undefined;
}

function readFilterModelsForEvents(
  rules: LifecycleRules,
  role: FilterRole,
  names: readonly string[]
): FilterModels {
  const models: [string, ConditionModel][] = [];

  for (const eventName of names) {
    const serialized = readFilter(rules, role, eventName);
    if (!serialized) {
      continue;
    }

    const parsed = parseConditionModel(serialized);
    if (!parsed.valid) {
      return {
        valid: false,
        error: `The ${roleLabel(role)} for "${eventName}" is invalid: ${parsed.error}`,
      };
    }

    // An incomplete model is valid while the builder is writing it. Publishing
    // applies the stricter check that requires every operand to be complete.
    const compiled = compileConditionModel(parsed.model);
    if (!compiled.valid && !compiled.incomplete) {
      return {
        valid: false,
        error: `The ${roleLabel(role)} for "${eventName}" is invalid: ${compiled.error}`,
      };
    }

    models.push([eventName, parsed.model]);
  }

  return { valid: true, models };
}

export function readFilterModels(
  rules: LifecycleRules,
  role: FilterRole
): FilterModels {
  return readFilterModelsForEvents(rules, role, eventNames(rules, role));
}

export function checkFilterModels(
  rules: LifecycleRules,
  role: FilterRole
): LifecycleRulesCheck {
  const read = readFilterModelsForEvents(
    rules,
    role,
    Object.keys(filters(rules, role) ?? {})
  );
  return read.valid ? lifecycleRulesValid : refuseLifecycleRules(read.error);
}

function unreadableFilterRule(input: {
  model: ConditionModel;
  catalog: ExtensionCatalog;
  eventName: string;
}): string | undefined {
  const payloadFields =
    findEvent(input.catalog, input.eventName)?.payloadFields ?? [];
  for (const group of input.model.groups) {
    for (const rule of group.conditions) {
      const path = rule.field.trim();

      if (isNullCheckConditionRule(rule)) {
        continue;
      }

      if (path === EVENT_NAME_FIELD_PATH) {
        if (rule.fieldType !== "string") {
          return `compares the arriving Event's name as ${rule.fieldType}, and a name is always text`;
        }
        continue;
      }

      const declaration = findConditionFieldDeclaration(payloadFields, rule);
      if (!declaration) {
        return `reads "${path}", which that Event does not carry`;
      }

      const offered = conditionTypeOf(declaration.field);
      if (offered === null) {
        return `compares "${path}", which that Event declares as a shape no rule can compare`;
      }
      if (offered !== rule.fieldType) {
        return `compares "${path}" as ${rule.fieldType}, which that Event now declares as ${offered}`;
      }
    }
  }

  return undefined;
}

/**
 * Checks every stored filter of `role` the way Publish does, and names what it
 * refuses the way the Start's form shows it: the filter by its name in the
 * form, and an Event by its label. A filter one control stands for across
 * several Events names no Event for a problem of the filter itself.
 */
export function checkFilters(input: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
  role: FilterRole;
}): LifecycleRulesCheck {
  const { rules, catalog, role } = input;
  const read = readFilterModels(rules, role);
  if (!read.valid) {
    return refuseLifecycleRules(read.error);
  }

  const name = `“${FILTER_RULE_NAMES[role]}”`;
  const sharedFilter =
    eventNames(rules, role).length > 1 &&
    readFilterLayout(rules, role).collapsed;
  for (const [eventName, model] of read.models) {
    const eventLabel = findEvent(catalog, eventName)?.label ?? eventName;
    const filter = sharedFilter ? name : `${name} for ${eventLabel}`;
    const compiled = compileConditionModel(model);
    if (!compiled.valid) {
      return refuseUnfinishedLifecycleRules(
        `${filter} has a rule that is not finished. Finish the rule, or remove it.`
      );
    }

    for (const group of model.groups) {
      for (const rule of group.conditions) {
        if (
          readConditionRuleOperands(rule).some(
            (operand) => findTemplateTokens(operand).length > 0
          )
        ) {
          const timing =
            role === "start"
              ? "before a run exists"
              : "before a run is canceled";
          return refuseLifecycleRules(
            `${filter} compares a value from a run. It is read ${timing}, so it can compare an Event's fields only with values typed into the rule.`
          );
        }
      }
    }

    const unreadable = unreadableFilterRule({ model, catalog, eventName });
    if (unreadable) {
      return refuseLifecycleRules(
        `${name} for ${eventLabel} ${unreadable}. Rebuild the rule against a field ${eventLabel} carries, or filter each Event separately.`
      );
    }
  }

  return lifecycleRulesValid;
}

function filterIdentity(serialized: string | undefined): string | undefined {
  if (!serialized) {
    return undefined;
  }

  const compiled = compileSerializedConditionModel(serialized);
  return compiled.valid ? compiled.expression : serialized;
}

export function readFilterLayout(
  rules: LifecycleRules,
  role: FilterRole
): FilterLayout {
  const stored = eventNames(rules, role).map((eventName) =>
    readFilter(rules, role, eventName)
  );

  if (new Set(stored.map(filterIdentity)).size > 1) {
    return { collapsed: false };
  }

  const model = stored.find((filter) => filter !== undefined);
  return model ? { collapsed: true, model } : { collapsed: true };
}

function writeFilters(
  rules: LifecycleRules,
  role: FilterRole,
  next: Record<string, string>
): LifecycleRules {
  const value = isEmptyObject(next) ? undefined : next;
  return role === "start"
    ? { ...rules, startFilters: value }
    : { ...rules, cancelFilters: value };
}

export function setFilterForEvent(input: {
  rules: LifecycleRules;
  role: FilterRole;
  eventName: string;
  model: string | undefined;
}): LifecycleRules {
  const next = new Map(Object.entries(filters(input.rules, input.role) ?? {}));
  if (input.model?.trim()) {
    next.set(input.eventName, input.model);
  } else {
    next.delete(input.eventName);
  }

  return writeFilters(input.rules, input.role, Object.fromEntries(next));
}

export function setFilterForAll(
  rules: LifecycleRules,
  role: FilterRole,
  model: string | undefined
): LifecycleRules {
  if (!model?.trim()) {
    return writeFilters(rules, role, {});
  }

  return writeFilters(
    rules,
    role,
    Object.fromEntries(
      eventNames(rules, role).map((eventName) => [eventName, model])
    )
  );
}

export function carryFilterToAddedEvents(input: {
  previous: LifecycleRules;
  next: LifecycleRules;
  catalog: ExtensionCatalog;
  role: FilterRole;
}): LifecycleRules {
  const layout = readFilterLayout(input.previous, input.role);
  if (!layout.collapsed || !layout.model) {
    return input.next;
  }

  const parsed = parseConditionModel(layout.model);
  if (!parsed.valid) {
    return input.next;
  }

  const carried = eventNames(input.next, input.role).filter(
    (eventName) =>
      unreadableFilterRule({
        model: parsed.model,
        catalog: input.catalog,
        eventName,
      }) === undefined
  );
  const nextFilters = new Map(
    Object.entries(filters(input.next, input.role) ?? {})
  );
  for (const eventName of carried) {
    nextFilters.set(eventName, layout.model);
  }

  return writeFilters(input.next, input.role, Object.fromEntries(nextFilters));
}

export function pruneFilters(
  rules: LifecycleRules,
  role: FilterRole
): LifecycleRules {
  const stored = filters(rules, role);
  if (!stored) {
    return rules;
  }

  return writeFilters(
    rules,
    role,
    retainNamedKeys(stored, new Set(eventNames(rules, role))) ?? {}
  );
}
