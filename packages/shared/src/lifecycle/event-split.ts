/**
 * The Event Split node's outlets, named where both sides can read them.
 *
 * A run reaching a node can have arrived on any of several Events (ADR-0007),
 * and this node is where a builder tells them apart: one outlet per Event that
 * can reach it, derived rather than configured, so no Event goes unlisted. Its
 * outlets are Event names, which is what lets the editor narrow what a node
 * behind one may address and the engine pick the branch a run belongs on.
 */

import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import {
  isEventSplitActionNode,
  type NodeConfigSource,
} from "#src/graph/node-config";

/**
 * What marks a handle as naming an Event.
 *
 * An Event name is the builder's own string and could be spelled `true` or
 * `started`, both of which already mean something as a handle, so the prefix is
 * what keeps one node's outlets from reading as another's.
 */
const EVENT_SPLIT_HANDLE_PREFIX = "event:";

/** The handle an edge leaving this node by the given Event's outlet carries. */
export function eventSplitOutlet(eventName: string): string {
  return `${EVENT_SPLIT_HANDLE_PREFIX}${eventName}`;
}

/** The Event a handle names, or null where it names none. */
export function eventSplitOutletEvent(sourceHandle: unknown): string | null {
  if (
    typeof sourceHandle !== "string" ||
    !sourceHandle.startsWith(EVENT_SPLIT_HANDLE_PREFIX)
  ) {
    return null;
  }

  const eventName = sourceHandle.slice(EVENT_SPLIT_HANDLE_PREFIX.length).trim();
  return eventName.length > 0 ? eventName : null;
}

/** Whether an action type names the node that splits a run by its Event. */
export function isEventSplitActionType(value: unknown): boolean {
  return value === BUILT_IN_ACTION_IDS.eventSplit;
}

/** Whether this node is the one that splits a run by the Event it arrived on. */
export function isEventSplitNode(node: NodeConfigSource | undefined): boolean {
  return isEventSplitActionNode(node);
}
