/**
 * The one owner of the Wait node's event-list contract. The list is written
 * into node config by the editor, copied into wait-state metadata by the
 * engine, and read back by resume matching; every hop goes through these two
 * functions so the shape has a single definition.
 */

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
