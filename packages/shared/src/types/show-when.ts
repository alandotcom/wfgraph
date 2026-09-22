/**
 * When a declarative field is offered, given the node's current config bag.
 *
 * Shared by config inputs (`ActionConfigFieldBase`) and catalog output fields
 * (`ReferenceField`). Not plugin-specific: built-ins such as Wait use the same
 * predicate on their output paths. Absent means always offered. Present means
 * the named config key must equal one literal or occur in the `in` list.
 * Matching is exact; an empty list never matches. Visibility preserves values.
 */

export type ShowWhen<TField extends string = string> = { field: TField } & (
  | { equals: string; in?: never }
  | { in: readonly string[]; equals?: never }
);

/** Whether this `showWhen` holds for the config, or there is no `showWhen`. */
export function matchesShowWhen(
  config: Record<string, unknown> | undefined,
  showWhen: ShowWhen | undefined
): boolean {
  if (!showWhen) {
    return true;
  }
  const value = config?.[showWhen.field];
  return (
    typeof value === "string" &&
    (showWhen.in === undefined
      ? value === showWhen.equals
      : showWhen.in.includes(value))
  );
}
