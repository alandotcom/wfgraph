/**
 * The declarative config form an action declares, as data.
 *
 * A field describes one input the editor draws in an action's config panel: what
 * to label it, which control to render, and which config key it writes. The
 * catalog carries these over the wire and `action-config-renderer.tsx` switches on
 * the type, so the set of types is closed by construction: a field the renderer
 * cannot draw is not a usable field.
 *
 * An integration is a value a host passes to `createWfGraphApp` and the editor reads
 * the catalog, so what is left here is the field vocabulary those two share and a
 * few helpers over a field list.
 */

import type { ShowWhen } from "#src/types/show-when";

/**
 * Select Option
 * Used for select/dropdown fields
 */
export type SelectOption = {
  value: string;
  label: string;
};

/**
 * The field types whose shape the node's connection answers.
 *
 * A closed union is matched against this rather than by name prefix, so adding a
 * type is one edit and a rename cannot quietly stop matching.
 */
export const PROVIDER_FIELD_TYPES = new Set<ActionConfigFieldBase["type"]>([
  "provider-select",
  "provider-fields",
]);

/**
 * Where a field's options or sub-fields come from, when the answer depends on
 * the connection the node names rather than on anything the catalog knows.
 *
 * `provider` names one entry of the integration's `configOptions` record.
 * `parameters` names sibling config keys whose values the question needs; a
 * named key holding nothing, or holding a `{{...}}` reference, means the field
 * cannot be asked yet and the renderer draws the plain control instead.
 */
export type FieldOptionsSource = {
  provider: string;
  parameters?: string[] | undefined;
};

/**
 * Base Action Config Field
 * Declarative definition of a config field for an action
 */
export type ActionConfigFieldBase = {
  // Unique key for this field in the config object
  key: string;

  // Human-readable label
  label: string;

  // Field type
  type:
    | "template-input" // TemplateBadgeInput - supports {{variable}}
    | "template-textarea" // TemplateBadgeTextarea - supports {{variable}}
    | "text" // Regular text input
    | "number" // Number input
    | "select" // Dropdown select
    | "key-value" // Dynamic key-value pair list
    | "provider-select" // Dropdown whose options the connection answers
    | "provider-fields"; // One input per field the connection answers with

  // Placeholder text
  placeholder?: string | undefined;

  // Default value
  defaultValue?: string | undefined;

  /**
   * The Connection value this field falls back to when it is left blank, so the
   * editor can draw it as the field's placeholder. Names one of the fields the
   * owning integration declares, and never a `password` one: a masked secret
   * would draw as `********`. The handler is what applies the fallback; this
   * only says where to read the hint.
   */
  connectionDefaultKey?: string | undefined;

  // Example value for AI prompt generation
  example?: string | undefined;

  // For select fields: list of options
  options?: SelectOption[] | undefined;

  // For provider-select and provider-fields: which connection question to ask
  optionsSource?: FieldOptionsSource | undefined;

  // Number of rows (for textarea)
  rows?: number | undefined;

  // Min value (for number fields)
  min?: number | undefined;

  // Whether this field is required (defaults to false)
  required?: boolean | undefined;

  // The value reaches the step as the builder typed it: template resolution
  // never reads this key. A test destination is the case it exists for, because
  // steering where a test message goes from a run's own payload is never what
  // the person who typed the address meant.
  literal?: true | undefined;

  // Conditional rendering: only show if another field has a specific value
  showWhen?: ShowWhen | undefined;

  /**
   * The open records whose keys this `key-value` field's names are, by the path
   * each record sits at.
   *
   * A record accepts keys no schema can list, so the editor would otherwise ask
   * for one to be typed. This is what lets it offer the keys instead: a Send
   * Email node tagged `name` makes `tags.name` a path the picker lists, on that
   * node's own output and on the integration's Events, which carry the same tags
   * back. Paths are matched inside one integration, so one integration's rows
   * never name another's record.
   *
   * Suggestions rather than a guarantee. An email tagged by something outside
   * this workflow carries keys no node here names, so a key typed by hand keeps
   * resolving whether it was offered or not.
   */
  fillsRecords?: string[] | undefined;
};

/**
 * Config Field Group
 * Groups related fields together in a collapsible section
 */
export type ActionConfigFieldGroup = {
  // Human-readable label for the group
  label: string;

  // Field type (always "group" for groups)
  type: "group";

  // Nested fields within this group
  fields: ActionConfigFieldBase[];

  // Whether the group is expanded by default (defaults to false)
  defaultExpanded?: boolean | undefined;
};

/**
 * Action Config Field
 * Can be either a regular field or a group of fields
 */
export type ActionConfigField = ActionConfigFieldBase | ActionConfigFieldGroup;

/**
 * Type guard to check if a field is a group
 */
export function isFieldGroup(
  field: ActionConfigField
): field is ActionConfigFieldGroup {
  return field.type === "group";
}

/**
 * Flatten config fields, extracting fields from groups
 * Useful for validation and AI prompt generation
 */
export function flattenConfigFields(
  fields: readonly ActionConfigField[]
): ActionConfigFieldBase[] {
  const result: ActionConfigFieldBase[] = [];

  for (const field of fields) {
    if (isFieldGroup(field)) {
      result.push(...field.fields);
    } else {
      result.push(field);
    }
  }

  return result;
}

/** How a config key's JSON is laid out, for the engine resolving inside it. */
export type TemplateJsonShape = "provider-fields" | "key-value";

/**
 * The config keys whose stored text is JSON holding authored templates, each
 * with the shape its text is in.
 *
 * The engine resolves those values one at a time rather than substituting into
 * the whole string. Substituting into the string is how a resolved value
 * carrying a quotation mark or a newline leaves the JSON unparseable, and the
 * step then reads no values at all rather than one wrong one.
 *
 * The shape comes along because the field already declares it. Handing over the
 * keys alone left the engine guessing which layout a string held, and a
 * `key-value` field holding text neither reader accepts would fall through to
 * the other one's rules rather than being handed back as authored.
 *
 * A group is a rendering decision, so a field inside one counts the same as one
 * beside it.
 */
export function templateJsonFieldShapes(
  fields: readonly ActionConfigField[]
): Array<[string, TemplateJsonShape]> {
  return flattenConfigFields(fields).flatMap((field) =>
    isTemplateJsonShape(field.type) ? [[field.key, field.type]] : []
  );
}

function isTemplateJsonShape(
  type: ActionConfigFieldBase["type"]
): type is TemplateJsonShape {
  return type === "provider-fields" || type === "key-value";
}

/**
 * The config keys an action declared `literal`, which the engine hands to the
 * step as they were authored.
 *
 * A group is a rendering decision, so a literal field inside one counts the same
 * as one beside it.
 */
export function literalFieldKeys(
  fields: readonly ActionConfigField[]
): string[] {
  return flattenConfigFields(fields)
    .filter((field) => field.literal === true)
    .map((field) => field.key);
}
