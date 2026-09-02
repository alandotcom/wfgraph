/**
 * The config form a step renders, from its input schema and what its author
 * added.
 *
 * The schema is the source of every key, its label and whether it is required.
 * An author writes only what a schema cannot say: a placeholder, a row count, a
 * friendly option label, a group, a `showWhen`. What they write wins per
 * property, and the order they write it in is the order the form draws.
 */

import { omit } from "es-toolkit/object";
import type {
  ActionConfigField,
  ActionConfigFieldBase,
} from "@wfgraph/shared/plugins/action-fields";
import { labelFromKey } from "@wfgraph/shared/graph/schema-codec";

/** An author's entry: the key, and whichever properties they chose to state. */
export type AuthoredField = Partial<Omit<ActionConfigFieldBase, "key">> & {
  key: string;
};

export type AuthoredGroup = {
  label: string;
  type: "group";
  fields: AuthoredField[];
  defaultExpanded?: boolean | undefined;
};

export type AuthoredEntry = AuthoredField | AuthoredGroup;

/**
 * `isFieldGroup` in `@wfgraph/shared` reads a finished field. This reads an
 * author's, whose `type` may be absent because the schema supplies it.
 */
function isAuthoredGroup(entry: AuthoredEntry): entry is AuthoredGroup {
  return entry.type === "group";
}

/**
 * The author's entry over the schema's, or the schema's alone.
 *
 * A `type` the author changed takes its extras with it: `options` belongs to a
 * select and `min` to a number, and either riding along onto a field the author
 * respelled as text would be a value nothing renders.
 *
 * A key the schema could not describe still draws, labelled from the key and
 * spelled as the field type that accepts anything. That is the case where the
 * input schema is one the derivation cannot read, which leaves the author's own
 * entries as the whole form.
 */
function mergeField(
  derived: ActionConfigFieldBase | undefined,
  authored: AuthoredField
): ActionConfigFieldBase {
  if (!derived) {
    return {
      label: labelFromKey(authored.key, authored.label),
      type: "template-input",
      ...authored,
    };
  }

  const base =
    authored.type === undefined || authored.type === derived.type
      ? derived
      : omit(derived, ["options", "min"]);

  return { ...base, ...authored };
}

function claimedKeys(authored: readonly AuthoredEntry[]): Set<string> {
  const keys = new Set<string>();

  for (const entry of authored) {
    if (isAuthoredGroup(entry)) {
      for (const field of entry.fields) {
        keys.add(field.key);
      }
      continue;
    }
    keys.add(entry.key);
  }

  return keys;
}

/**
 * The form, with the author's entries first and every unclaimed schema key
 * after them in the order the schema declares them.
 *
 * The author's list is the spine because a group has no derived counterpart to
 * take its position from, and a group's position is a decision: Twilio's
 * "Advanced" sits under the message rather than wherever a key order put it.
 * An author who writes nothing gets the schema's own list, which is the whole
 * point of deriving one.
 */
export function buildConfigForm(
  derived: readonly ActionConfigFieldBase[],
  authored: readonly AuthoredEntry[]
): ActionConfigField[] {
  // A Map rather than a keyBy record: a field key is arbitrary text from an
  // integration author, and a plain object would answer a key named
  // `constructor` with a prototype member instead of undefined.
  const derivedByKey = new Map(derived.map((field) => [field.key, field]));
  const claimed = claimedKeys(authored);

  const spine = authored.map((entry): ActionConfigField =>
    isAuthoredGroup(entry)
      ? {
          ...entry,
          fields: entry.fields.map((field) =>
            mergeField(derivedByKey.get(field.key), field)
          ),
        }
      : mergeField(derivedByKey.get(entry.key), entry)
  );

  return [...spine, ...derived.filter((field) => !claimed.has(field.key))];
}
