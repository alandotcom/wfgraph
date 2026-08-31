/**
 * The Events a graph names, held to the rules a save is refused by.
 *
 * The vocabulary is the assembled catalog, which the caller reads off the
 * `Extensions` service, so this runs where a graph is written and again before a
 * run: an Event a workflow names has to be one the app still defines, whether the
 * entry node named it as a lifecycle role or a Wait node parks on it.
 */

import {
  type ExtensionCatalog,
  findEvent,
} from "@wfgraph/shared/extensions/catalog";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { eventsReaching } from "@wfgraph/shared/graph/events-reaching";
import {
  eventSplitOutletEvent,
  isEventSplitNode,
} from "@wfgraph/shared/lifecycle/event-split";
import {
  checkLifecycleRules,
  hostEventConnectionMessage,
  missingConnectionMessage,
  readLifecycleRules,
  unknownEventMessage,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { getNodeLabel } from "#src/backend/services/workflows/validation/workflow-graph";
import { readWaitSubscriptions } from "@wfgraph/shared/lifecycle/wait-subscription";

export type WorkflowLifecycleValidationResult =
  | { valid: true }
  | { valid: false; error: string };

/**
 * Every Event Split's outlets, held to the Events that can actually reach it.
 *
 * The node's outlets are derived rather than configured, so a handle naming
 * anything else belongs to a graph whose Events cannot actually reach it, or
 * to an API write. Either way it is a branch no run travels, which is silence
 * a builder cannot see, so the save says it instead.
 */
export function validateEventSplitOutlets(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  catalog: ExtensionCatalog
): WorkflowLifecycleValidationResult {
  for (const node of nodes) {
    if (!isEventSplitNode(node)) {
      continue;
    }

    const reachable = new Set(
      eventsReaching({
        targetNodeId: node.id,
        nodes,
        edges,
        catalog,
      }).map((event) => event.name)
    );

    for (const edge of edges) {
      if (edge.source !== node.id) {
        continue;
      }

      const eventName = eventSplitOutletEvent(edge.sourceHandle);
      if (!eventName) {
        return {
          valid: false,
          error: `Node "${getNodeLabel(node)}" has an edge that leaves by no outlet. Every edge out of a split names the Event it carries.`,
        };
      }

      if (!reachable.has(eventName)) {
        return {
          valid: false,
          error: `Node "${getNodeLabel(node)}" splits on "${eventName}", which cannot reach it. Remove that branch, or name the Event on the Lifecycle Node or a Wait above this split.`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Every Event a graph names, as the entry node's lifecycle role or a Wait
 * node's subscription, held to the same catalog.
 *
 * A graph whose entry node carries no rules passes: the panel writes them, and
 * refusing a graph that predates the panel would lock the editor out of the one
 * screen that can add them. A name neither role declares describes a wait that
 * no arrival can satisfy, so the run holds until its timeout with nothing said;
 * the editor offers only catalog Events, and this is the half of that rule an
 * API write also passes through.
 */
export function validateWorkflowEvents(
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): WorkflowLifecycleValidationResult {
  for (const node of nodes) {
    if (node.data.type === "lifecycle") {
      const rules = readLifecycleRules(node.data.config);
      if (rules) {
        const check = checkLifecycleRules({ rules, catalog });
        if (!check.valid) {
          return check;
        }
      }
      continue;
    }

    if (node.data.config?.actionType === BUILT_IN_ACTION_IDS.wait) {
      for (const subscription of readWaitSubscriptions(node.data.config)) {
        const event = findEvent(catalog, subscription.event);
        if (!event) {
          return {
            valid: false,
            error: unknownEventMessage(subscription.event),
          };
        }
        if (!event.integration && subscription.connectionId) {
          return {
            valid: false,
            error: hostEventConnectionMessage(subscription.event),
          };
        }
        if (event.integration && !subscription.connectionId) {
          return {
            valid: false,
            error: missingConnectionMessage(
              subscription.event,
              event.integration,
              catalog,
              "resume"
            ),
          };
        }
      }
    }
  }

  return { valid: true };
}
