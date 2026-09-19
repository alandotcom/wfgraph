/**
 * What Canvas Reveal says about an Event Split node, as pure functions: the
 * Event sources its outlets come from, the row for each Event name a stored
 * edge or the reachable set names, and the connections that leave by no outlet.
 */

import { compact } from "es-toolkit/array";
import { eventSplitOutletEvent } from "@wfgraph/shared/lifecycle/event-split";
import {
  findEvent,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import type { ArrivingEventSource } from "@wfgraph/shared/graph/events-reaching";
import { getNodeDisplayName } from "@wfgraph/shared/graph/node-display";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

/** A step one Event Split connection leads to, through the edge `edgeId`. */
export type EventSplitOutletTarget = {
  edgeId: string;
  nodeId: string;
  label: string;
};

/**
 * One Event name an Event Split shows, whether or not it is still reachable.
 * `label` is the catalog's label when the Event is still declared, and null
 * when the app no longer declares it. `reachable` is false for an Event a
 * stored edge still names that no longer reaches the node, which is a branch
 * no run can take until the graph above it changes.
 */
export type EventSplitOutletRow = {
  eventName: string;
  label: string | null;
  description?: string | undefined;
  reachable: boolean;
  targets: readonly EventSplitOutletTarget[];
};

/**
 * An Event source that owns an Event Split's outlets, with the phrase naming
 * where its Events are set (`description`) and the label of the action that
 * opens it (`actionLabel`).
 */
export type EventSplitOwner = {
  source: ArrivingEventSource;
  description: string;
  actionLabel: string;
};

/**
 * Every row an Event Split's Browse shows, and `withoutOutlet`, the steps a
 * stored edge leaving the node by no named outlet connects to. Rows cover the
 * reachable Events (`reachableEventNames`) and any Event a stored edge still
 * names that has fallen out of that set, once each, reachable Events first.
 */
export function eventSplitConnections(input: {
  nodeId: string;
  reachableEventNames: readonly string[];
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): {
  rows: EventSplitOutletRow[];
  withoutOutlet: EventSplitOutletTarget[];
} {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const connections = compact(
    input.edges.map((edge) => {
      const target =
        edge.source === input.nodeId ? nodesById.get(edge.target) : undefined;
      return target
        ? {
            eventName: eventSplitOutletEvent(edge.sourceHandle),
            target: {
              edgeId: edge.id,
              nodeId: target.id,
              label: getNodeDisplayName(input.catalog, target),
            },
          }
        : undefined;
    })
  );
  // Event names come from stored edge handles, which the build agent can
  // write, so the grouping is a Map.
  const targetsByEvent = Map.groupBy(
    connections,
    (connection) => connection.eventName
  );
  const withoutOutlet = (targetsByEvent.get(null) ?? []).map(
    (connection) => connection.target
  );
  const targetsOf = (eventName: string) =>
    (targetsByEvent.get(eventName) ?? []).map(
      (connection) => connection.target
    );

  const reachable = new Set(input.reachableEventNames);
  const staleEventNames = [...targetsByEvent.keys()].filter(
    (eventName): eventName is string =>
      eventName !== null && !reachable.has(eventName)
  );
  const rows = [...input.reachableEventNames, ...staleEventNames].map(
    (eventName) => {
      const event = findEvent(input.catalog, eventName);
      return omitUndefined({
        eventName,
        label: event?.label ?? null,
        description: event?.description,
        reachable: reachable.has(eventName),
        targets: targetsOf(eventName),
      });
    }
  );
  return { rows, withoutOutlet };
}

/** The owner an Event source is shown as, named from the graph it sits in. */
export function eventSplitOwner(input: {
  source: ArrivingEventSource;
  nodes: readonly WorkflowNode[];
  catalog: ExtensionCatalog;
}): EventSplitOwner {
  const { source } = input;
  if (source.kind === "lifecycle") {
    return source.side === "started"
      ? {
          source,
          description: "the Lifecycle Node's Start Events",
          actionLabel: "Open Lifecycle Start Events",
        }
      : {
          source,
          description: "the Lifecycle Node's Cancel Events",
          actionLabel: "Open Lifecycle Cancel Events",
        };
  }
  const wait = input.nodes.find((node) => node.id === source.nodeId);
  const waitLabel = wait ? getNodeDisplayName(input.catalog, wait) : "Wait";
  return {
    source,
    description: `the Wait Subscriptions of ${waitLabel}`,
    actionLabel: `Open ${waitLabel}`,
  };
}

/** The owners' descriptions as one phrase: "A", "A and B", or "A, B and C". */
export function ownersPhrase(owners: readonly EventSplitOwner[]): string {
  const descriptions = owners.map((owner) => owner.description);
  const last = descriptions.at(-1) ?? "";
  return descriptions.length <= 1
    ? last
    : `${descriptions.slice(0, -1).join(", ")} and ${last}`;
}
