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

/** An empty list means the wait resumes on any event for its entity. */
export function waitMatchesEvent(
  waitForEvents: string[],
  eventType: string
): boolean {
  return waitForEvents.length === 0 || waitForEvents.includes(eventType);
}
