/**
 * Names a stored path that the current graph no longer offers. The picker and
 * read-only summary share this label so both surfaces describe the rule alike.
 */
export function unavailableFieldLabel(path: string): string {
  return `${path} (Unavailable)`;
}
