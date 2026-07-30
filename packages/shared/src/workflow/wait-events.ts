/**
 * The one owner of the Wait node's event-list contract. The list is written
 * into node config by the editor, copied onto the wait row by the engine, and
 * read back by resume matching; every hop goes through these functions so the
 * shape has a single definition.
 */

import type { WorkflowNode } from "#src/workflow/types";

/** The action type of the built-in Wait step, which is what parks on an Event. */
const WAIT_ACTION_TYPE = "Wait";

/** Blank entries are noise from editing, never a matchable Event Type. */
export function readWaitForEvents(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim() !== ""
  );
}

/**
 * Whether one arriving Event is one this wait parks on.
 *
 * The list is never empty: an event-mode Wait node with no Event named is refused
 * at save. It used to mean "any Event for this entity", and the derived
 * subscription index has no way to spell that -- a wildcard subscribes a workflow
 * to every Event there is -- so the wildcard is a configuration error now rather
 * than a shape with two meanings.
 */
export function waitMatchesEvent(
  waitForEvents: string[],
  eventType: string
): boolean {
  return waitForEvents.includes(eventType);
}

/**
 * Every Event name the graph's Wait nodes park on, in node order.
 *
 * A wait matches by Entity Value the way a cancel does, so these names are part of
 * what the Lifecycle Rules are checked against. The save path and the panel that
 * writes the rules both read them from here, so a builder is shown the refusal the
 * server would give.
 */
export function readWaitEventNames(nodes: readonly WorkflowNode[]): string[] {
  return nodes.flatMap((node) =>
    node.data.config?.actionType === WAIT_ACTION_TYPE
      ? readWaitForEvents(node.data.config.waitForEvents)
      : []
  );
}
