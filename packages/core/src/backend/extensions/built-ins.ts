/**
 * What the engine ships itself, as catalog entries.
 *
 * They belong here rather than in the browser because the catalog is the one
 * channel the editor learns the surface through: a built-in the browser knew
 * about on its own would be an action selector that disagrees with what the
 * server can run.
 *
 * Each is the engine's own work rather than a `defineStep` value -- Condition
 * evaluates its expression during the traversal, Wait suspends the run, Event
 * Split routes on the Event the run arrived on -- so they reach the editor as
 * metadata and nothing dispatches to them. Each `configFields` is empty because
 * each is configured by a bespoke panel in the editor, written against the shape
 * it has, rather than through the declarative field list a plugin action
 * declares.
 */

import { BUILT_IN_ACTION_IDS } from "@rova/shared/actions/built-in-actions";
import type { ActionMetadata } from "@rova/shared/extensions/catalog";

export const builtInActions: readonly ActionMetadata[] = [
  {
    id: BUILT_IN_ACTION_IDS.condition,
    label: "Condition",
    description: "Branch based on a condition",
    category: "System",
    configFields: [],
    // The engine evaluates the expression and picks an outlet. Nothing
    // downstream reads a value from it, so there is no path to offer.
    outputFields: [],
  },
  {
    id: BUILT_IN_ACTION_IDS.eventSplit,
    label: "Event Split",
    description: "Send a run down the branch belonging to its Event",
    category: "System",
    configFields: [],
    // The outlets are derived from the Events reaching the node, so the panel
    // asks the graph rather than the config. Nothing downstream reads a value
    // from it: what a run learns here is which branch it is on.
    outputFields: [],
  },
  {
    id: BUILT_IN_ACTION_IDS.wait,
    label: "Wait",
    description: "Delay execution or wait for an Event",
    category: "System",
    configFields: [],
    // What both modes leave behind, plus the arriving Event's name and payload
    // for an event wait. `payload` is offered as one object rather than as
    // leaves, because each Event the node parks on carries its own payload
    // shape and the catalog has one field list for the node. A builder writes
    // `payload.<field>` themselves, and reads `event` to learn which Event
    // arrived.
    outputFields: [
      {
        path: "waitType",
        description: "delay or event",
        type: "string",
      },
      {
        path: "timedOut",
        description: "Whether the wait ended on its timeout",
        type: "boolean",
      },
      {
        path: "resumedAt",
        description: "When the run left the wait",
        type: "timestamp",
        format: "timestamp",
      },
      {
        path: "event",
        description: "The name of the Event that resumed the run",
        type: "string",
      },
      {
        path: "payload",
        description: "The payload of the Event that resumed the run",
        type: "object",
      },
    ],
  },
];
