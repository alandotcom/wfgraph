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
    | "key-value"; // Dynamic key-value pair list

  // Placeholder text
  placeholder?: string;

  // Default value
  defaultValue?: string;

  // Example value for AI prompt generation
  example?: string;

  // For select fields: list of options
  options?: SelectOption[];

  // Number of rows (for textarea)
  rows?: number;

  // Min value (for number fields)
  min?: number;

  // Whether this field is required (defaults to false)
  required?: boolean;

  // The value reaches the step as the builder typed it: template resolution
  // never reads this key. A test destination is the case it exists for, since
  // steering where a test message goes from a run's own payload is never what
  // the person who typed the address meant.
  literal?: true;

  // Conditional rendering: only show if another field has a specific value
  showWhen?: ShowWhen;
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
  defaultExpanded?: boolean;
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
