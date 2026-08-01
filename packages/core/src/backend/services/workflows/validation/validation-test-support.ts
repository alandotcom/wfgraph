/**
 * The sentence a refusal carries, or an empty string where it accepted.
 *
 * Every validator in this directory answers the same discriminated shape, and a
 * case asserting the wording needs the error arm without narrowing at the call
 * site.
 */
export function errorOf(result: { valid: boolean; error?: string }): string {
  return result.error ?? "";
}
