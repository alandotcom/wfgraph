/**
 * A string as a CEL literal, quoted and escaped.
 *
 * `JSON.stringify` is the escaping CEL wants -- double quotes, backslashes
 * doubled, a newline or control character written as an escape rather than laid
 * into the source -- and it is how Inngest's own docs write one. Every
 * expression Rova assembles by hand goes through this: the source filter beside
 * it here, the wait subscription's `if` in `workflow-engine/core.ts`, and the
 * run function's trigger filter in `inngest/workflow-function.ts`. Those last
 * two sit on opposite sides of the runtime port, which is why the helper lives
 * in the package both halves can reach.
 */
export function celStringLiteral(value: string): string {
  return JSON.stringify(value);
}
