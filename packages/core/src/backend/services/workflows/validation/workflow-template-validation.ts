/**
 * Every `{{@nodeId:Label.field}}` a graph carries, held to what the field it
 * names can answer.
 *
 * A token that cannot resolve is silence at run time rather than a failure: the
 * engine renders a missing path as empty text, and a duration parser is then
 * handed the empty string. The picker already declines to write most of what is
 * refused here, so this catches a graph written before the rule or through the
 * API.
 */

import { keyBy } from "es-toolkit/array";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import {
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import { eventsReaching } from "@wfgraph/shared/graph/events-reaching";
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import {
  absentOn,
  reachableEventFields,
} from "@wfgraph/shared/graph/reachable-fields";
import {
  targetAccepts,
  type ValueTargetType,
} from "@wfgraph/shared/graph/value-targets";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { flattenConfigFields } from "@wfgraph/shared/plugins/action-fields";
import { waitValueTargetsFor } from "@wfgraph/shared/lifecycle/wait-subscription";
import { getNodeLabel } from "#src/backend/services/workflows/validation/workflow-graph";

export type WorkflowTemplateValidationResult =
  | { valid: true }
  | { valid: false; error: string };

/**
 * What a config key expects of the value written into it.
 *
 * `literal` is the key the engine hands to a step as authored, without resolving
 * templates into it (`processTemplates`), so a token there is text and no parser
 * ever sees it.
 */
type ValueTarget = {
  type?: ValueTargetType | undefined;
  required: boolean;
  literal?: true | undefined;
};

/**
 * What each config key of this node expects.
 *
 * The Wait node's own keys are declared as data beside its config schema,
 * because its panel is bespoke and its catalog entry lists no fields, and they
 * are seeded only for that node: another action is free to have a key called
 * `waitUntil` and mean something else by it. Everything else reads the fields
 * the action declared, which carry a required flag and no type: a plugin's
 * template input takes whatever text it is given.
 */
function valueTargets(
  node: WorkflowNode,
  catalog: ExtensionCatalog
): Map<string, ValueTarget> {
  const targets = new Map<string, ValueTarget>();

  const actionType = node.data.config?.actionType;
  if (typeof actionType !== "string") {
    return targets;
  }

  // Only the keys the node's current shape reads: a leftover timeout on a wait
  // now on a clock is a value no run consults, and its input is off screen.
  if (actionType === BUILT_IN_ACTION_IDS.wait) {
    for (const [key, target] of Object.entries(
      waitValueTargetsFor(node.data.config ?? {})
    )) {
      targets.set(key, target);
    }
  }

  const action = findAction(catalog, actionType);
  for (const field of flattenConfigFields(action?.configFields ?? [])) {
    targets.set(field.key, {
      required: field.required === true,
      literal: field.literal,
    });
  }

  return targets;
}

/** Whether any of this config's own values could carry a token at all. */
function holdsTemplate(config: Record<string, unknown>): boolean {
  return Object.values(config).some(
    (value) => typeof value === "string" && value.includes("{{")
  );
}

export function validateWorkflowTemplates(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): WorkflowTemplateValidationResult {
  const { nodes, edges, catalog } = input;
  const nodeById = keyBy(nodes, (node) => node.id);

  for (const node of nodes) {
    const config = node.data.config;
    // Reconciling costs a walk up to the entry node, and this runs on every
    // autosave, so a node with nothing to interpolate is passed over before it.
    if (node.data.type !== "action" || !config || !holdsTemplate(config)) {
      continue;
    }

    const targets = valueTargets(node, catalog);
    // The entry node's output is the payload of whichever Event put the run
    // here, and several Events can. An action's output has one shape, so only a
    // reference to the entry node needs reconciling.
    const reaching = eventsReaching({
      targetNodeId: node.id,
      nodes,
      edges,
      catalog,
    });
    const entryFields = keyBy(
      reachableEventFields(reaching),
      (field) => field.path
    );

    for (const [key, value] of Object.entries(config)) {
      if (typeof value !== "string") {
        continue;
      }

      const target = targets.get(key);
      if (target?.literal) {
        continue;
      }

      for (const token of findTemplateTokens(value)) {
        if (nodeById[token.nodeId]?.data.type !== "lifecycle") {
          continue;
        }

        const field = entryFields[token.fieldPath];
        if (!field) {
          continue;
        }

        const where = `Node "${getNodeLabel(node)}" reads ${token.fieldPath}`;

        if (field.typeClash) {
          return {
            valid: false,
            error: `${where}, which ${field.typeClash.events.join(" and ")} type differently. Add an Event Split above it, or read a path they agree on.`,
          };
        }

        if (
          target?.type &&
          !targetAccepts(field, target.type, { allowNumber: true })
        ) {
          return {
            valid: false,
            error: `${where} into ${key}, which takes a ${target.type}. That path is a ${field.type}.`,
          };
        }

        const absent = target?.required ? absentOn(field, reaching) : [];
        if (absent.length > 0) {
          return {
            valid: false,
            error: `${where} into ${key}, which ${absent.join(" and ")} does not carry. Add an Event Split above it, so this branch only runs for the Events that do.`,
          };
        }
      }
    }
  }

  return { valid: true };
}
