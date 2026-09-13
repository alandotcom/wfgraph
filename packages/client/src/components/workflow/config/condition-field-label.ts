/**
 * Two labels shown instead of a raw stored value: a path the current graph no
 * longer offers, and an enum value shown as the field's own label. The picker
 * and the read-only summary share both so every surface describes a rule alike.
 */

import type { ConditionSelectableField } from "#src/lib/upstream-node-fields";

export function unavailableFieldLabel(path: string): string {
  return `${path} (Unavailable)`;
}

export function enumOptionLabel(
  field: ConditionSelectableField | undefined,
  value: string
): string {
  return field?.enumLabels?.[value] ?? value;
}
