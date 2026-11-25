import { isBlank } from "@wfgraph/shared/types/string";

/**
 * Whether the user typed anything into the credential fields.
 *
 * On the edit form this is also how "keep the stored credentials" is said: the
 * secret fields render as Configured until the user chooses to replace them, so
 * an empty config means untouched rather than blank.
 */
export function hasProvidedConfigValues(
  config: Record<string, string>
): boolean {
  return Object.values(config).some((value) => !isBlank(value));
}
