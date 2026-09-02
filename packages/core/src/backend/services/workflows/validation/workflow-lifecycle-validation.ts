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
  type LifecycleRules,
  hostEventConnectionMessage,
  missingConnectionMessage,
  readLifecycleRules,
  unknownEventMessage,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import {
  checkStartFilterModels,
  checkStartFilters,
} from "@wfgraph/shared/lifecycle/start-filters";
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
 * The Lifecycle Rules of every entry node, held to one check.
 *
 * Three checks walk the nodes for the same thing, and a graph carrying no rules
 * passes all three: the panel writes them, and refusing a graph that predates
 * the panel would lock the editor out of the one screen that can add them.
 */
function checkEveryLifecycleNode(
  nodes: readonly WorkflowNode[],
  check: (rules: LifecycleRules) => WorkflowLifecycleValidationResult
): WorkflowLifecycleValidationResult {
  for (const node of nodes) {
    if (node.data.type !== "lifecycle") {
      continue;
    }

    const rules = readLifecycleRules(node.data.config);
    const result = rules ? check(rules) : { valid: true as const };
    if (!result.valid) {
      return result;
    }
  }

  return { valid: true };
}

/**
 * Every Start Filter, read as far as a stored graph has to be readable.
 *
 * The save battery's entry, beside the Wait matches the conditions battery reads
 * for the same reason: a filter compiles at delivery rather than at save, so a
 * model that will not compile at all would first be found by an arriving Event,
 * and the only trace would be a workflow that stopped starting. An unfinished
 * model passes, because that is what a builder mid-edit has written and every
 * keystroke autosaves.
 */
export function validateStartFilterModels(
  nodes: readonly WorkflowNode[]
): WorkflowLifecycleValidationResult {
  return checkEveryLifecycleNode(nodes, checkStartFilterModels);
}

/**
 * Every Start Filter, held to what a run can be decided by.
 *
 * Publish only, and deliberately not part of `validateWorkflowEvents`: that one
 * runs in preflight on every arrival, and a filter reading a field the Event
 * Author has since renamed would then answer `graph_unrunnable` for the whole
 * workflow, taking the Cancel Events down with it and writing no row anybody can
 * read. Left to publish, the same drift makes the filter read false and record a
 * Refused Start per arrival, which is the failure a builder can see.
 */
export function validateStartFilters(
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): WorkflowLifecycleValidationResult {
  return checkEveryLifecycleNode(nodes, (rules) =>
    checkStartFilters({ rules, catalog })
  );
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
  const rulesCheck = checkEveryLifecycleNode(nodes, (rules) =>
    checkLifecycleRules({ rules, catalog })
  );
  if (!rulesCheck.valid) {
    return rulesCheck;
  }

  for (const node of nodes) {
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
