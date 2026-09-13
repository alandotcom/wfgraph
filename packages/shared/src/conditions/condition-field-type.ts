/**
 * What a catalog field offers a condition rule: the operators it can be compared
 * with, or nothing where it can be compared at all.
 *
 * Shared because two readers have to agree. The editor derives the picker from
 * it, and `start-filters.ts` holds a stored rule to it at publish; a rule whose
 * `fieldType` disagrees with the declaration compiles to an operator the payload
 * cannot answer, and every arrival is then refused as unevaluable.
 */

import type {
  ConditionFieldType,
  ConditionRule,
} from "#src/conditions/condition-model";
import type {
  WorkflowSchemaFieldType,
  WorkflowSchemaItemType,
} from "#src/graph/schema-codec";
import {
  appendOutputPathKey,
  type ReferenceField,
} from "#src/graph/node-references";

export function toConditionFieldType(field: {
  type?: WorkflowSchemaFieldType | undefined;
}): ConditionFieldType | null {
  if (field.type === "timestamp") {
    return "timestamp";
  }

  if (
    field.type === "string" ||
    field.type === "number" ||
    field.type === "boolean"
  ) {
    return field.type;
  }

  // A duration is a string on the wire, and the condition vocabulary has no
  // operators for a length of time, so a rule compares the written form.
  if (field.type === "duration") {
    return "string";
  }

  // Fields without an explicit type (common for custom action outputFields) default to string
  if (field.type === undefined) {
    return "string";
  }

  return null;
}

/**
 * The rule vocabulary one catalog field offers, records included.
 *
 * An open record is an object, and an object has no operators, so reading its
 * own type would drop it. What a rule actually compares is a key under it, so
 * the record answers with the type its values carry and the row asks for the
 * key. Anything else answers for itself.
 */
export function conditionTypeOf(field: {
  type?: WorkflowSchemaFieldType | undefined;
  valueType?: WorkflowSchemaItemType | undefined;
}): ConditionFieldType | null {
  return toConditionFieldType(
    field.valueType ? { type: field.valueType } : field
  );
}

export type ConditionFieldDeclaration = {
  field: ReferenceField;
  nullable: boolean;
};

function isKeyUnder(recordPath: string, path: string): boolean {
  if (!path.startsWith(`${recordPath}.`)) {
    return false;
  }

  const rest = path.slice(recordPath.length + 1);
  return rest.length > 0 && !rest.includes(".");
}

/** Finds the declared field a condition rule reads, including keys under open records. */
export function findConditionFieldDeclaration(
  fields: readonly ReferenceField[],
  rule: Pick<ConditionRule, "field" | "recordKey">
): ConditionFieldDeclaration | undefined {
  const path = rule.field.trim();
  const key = rule.recordKey?.trim();

  if (key) {
    const base = fields.find((field) => field.path === path);
    if (base?.valueType) {
      return { field: base, nullable: true };
    }

    const field = fields.find(
      (candidate) => candidate.path === appendOutputPathKey(path, key)
    );
    return field ? { field, nullable: field.nullable === true } : undefined;
  }

  const exact = fields.find((field) => field.path === path);
  if (exact) {
    return { field: exact, nullable: exact.nullable === true };
  }

  const openRecord = fields.find(
    (field) => field.valueType && isKeyUnder(field.path, path)
  );
  return openRecord ? { field: openRecord, nullable: true } : undefined;
}
