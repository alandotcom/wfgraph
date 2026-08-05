/**
 * When a declarative field is offered, given the node's current config bag.
 *
 * Shared by config inputs (`ActionConfigFieldBase`) and catalog output fields
 * (`ReferenceField`). Not plugin-specific: built-ins such as Wait use the same
 * predicate on their output paths. Absent means always offered. Present means
 * the named config key must hold `equals`.
 */

export type ShowWhen = {
  field: string;
  equals: string;
};

/** Whether this `showWhen` holds for the config, or there is no `showWhen`. */
export function matchesShowWhen(
  config: Record<string, unknown> | undefined,
  showWhen: ShowWhen | undefined
): boolean {
  return !showWhen || config?.[showWhen.field] === showWhen.equals;
}
