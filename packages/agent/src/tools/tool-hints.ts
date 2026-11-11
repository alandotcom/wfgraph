/**
 * The behaviour hints each tool carries, written once on the canonical tool so
 * every surface that lists it reads the same values. The MCP adapter sends
 * them as tool annotations. Effect's defaults follow the MCP specification's:
 * an unset hint reads as a destructive, non-idempotent, open-world write, so
 * every tool here states all four.
 *
 * Every tool in this package touches only the workflow draft and the host's
 * catalog, which is a closed world.
 */

import { Context } from "effect";
import { Tool } from "effect/ai";

/** A tool that reads and never changes anything. */
export function readHints(title: string): Context.Context<never> {
  return Context.make(Tool.Title, title).pipe(
    Context.add(Tool.Readonly, true),
    Context.add(Tool.Destructive, false),
    Context.add(Tool.Idempotent, true),
    Context.add(Tool.OpenWorld, false)
  );
}

/**
 * A tool that changes the draft. `destructive` is true for a tool that removes
 * or overwrites something a person may have made, and `idempotent` is true when
 * repeating the same call leaves the draft as the first call left it.
 */
export function writeHints(input: {
  readonly title: string;
  readonly destructive: boolean;
  readonly idempotent: boolean;
}): Context.Context<never> {
  return Context.make(Tool.Title, input.title).pipe(
    Context.add(Tool.Readonly, false),
    Context.add(Tool.Destructive, input.destructive),
    Context.add(Tool.Idempotent, input.idempotent),
    Context.add(Tool.OpenWorld, false)
  );
}
