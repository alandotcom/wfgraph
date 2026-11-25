/**
 * Labels shown instead of raw stored values: a field the current graph no
 * longer offers, and an enum value shown as the field's own label. The picker
 * and the read-only summary share both so every surface describes a rule alike.
 */

import type { ConditionSelectableField } from "#src/lib/upstream-node-fields";
import { enumLabelForValue } from "@wfgraph/shared/graph/enum-metadata";

export function unavailableFieldLabel(): string {
  return "Unavailable field";
}

export function enumOptionLabel(
  field: ConditionSelectableField | undefined,
  value: string
): string {
  return enumLabelForValue(field?.enumLabels, value) ?? value;
}

/**
 * `fields` with each label two or more of them share followed by the step it
 * comes from, "Status · Patient State", so a rule that names one says which.
 * A label no other field has is left alone.
 */
export function namedBySource(
  fields: readonly ConditionSelectableField[]
): ConditionSelectableField[] {
  // A Map, since a label can be text a person typed on a step.
  const shared = new Set(
    [...Map.groupBy(fields, (field) => field.label)]
      .filter(([, group]) => group.length > 1)
      .map(([label]) => label)
  );
  return fields.map((field) =>
    shared.has(field.label)
      ? { ...field, label: `${field.label} · ${field.sourceNodeLabel}` }
      : field
  );
}
