/**
 * A string as a CEL literal, quoted and escaped.
 *
 * `JSON.stringify` is the escaping CEL wants -- double quotes, backslashes
 * doubled, a newline or control character written as an escape rather than laid
 * into the source -- and it is how Inngest's own docs write one. Every
 * expression Workflow Graph assembles by hand goes through this. It lives in the shared
 * package because its callers sit on both sides of the runtime port.
 */
export function celStringLiteral(value: string): string {
  return JSON.stringify(value);
}
